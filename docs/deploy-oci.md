# OCI 배포 절차

## 1. 계정 준비

**PAYG(종량제)로 업그레이드한다.** Always Free 계정의 유휴 인스턴스는 회수 대상이며,
저부하 폴링 워커는 정확히 그 프로필에 해당한다. PAYG 전환 후에도 Always Free 한도
안에서만 쓰면 청구액은 $0이다.

## 2. 인스턴스

- 이미지: Ubuntu 22.04 LTS
- Shape: `VM.Standard.E2.1.Micro` (Always Free, 1GB)
  - ARM(Ampere A1)은 용량 부족이 상습적이므로 기다리지 않는다. 나중에 잡히면 이전한다.
- 인바운드 포트: **SSH(22)만 연다.** 워커는 전부 아웃바운드라 다른 포트가 필요 없다.

## 3. 데이터베이스 준비 (Supabase)

1. Supabase 프로젝트를 **서울 리전(ap-northeast-2)**으로 생성한다. 국외이전 이슈를
   피하고 DART/텔레그램 호출과의 왕복 지연도 줄어든다.
2. 프로젝트의 Database 설정에서 연결 문자열을 받아 `DATABASE_URL`로 쓴다.
3. **마이그레이션을 먼저 적용한다 — 컨테이너를 처음 띄우기 전에, 반드시.** 워커는
   시작할 때 스키마를 자동 생성하지 않는다. 저장소(레포)가 있는 아무 머신에서나
   (배포 대상 VM일 필요 없다) 아래를 실행한다:

   ```bash
   DATABASE_URL="<supabase 연결 문자열>" \
     pnpm --filter @app/worker exec drizzle-kit migrate
   ```

   `apps/worker/drizzle/0000_*.sql`이 적용되어 `events`, `outbox`, `api_usage` 테이블이
   생긴다. 이걸 건너뛰면 컨테이너는 정상적으로 뜨지만 첫 사이클에서 바로
   `relation "events" does not exist` 류의 DB 에러로 실패한다.

## 4. 환경 변수 (`worker.env`)

`docker run --env-file`로 넘길 파일에 아래 키를 모두 채운다. 하나라도 빠지거나
형식이 안 맞으면 워커는 시작 직후 설정 검증에서 죽는다(정상 동작 — crash-only 설계).
"선택 항목"으로 표시된 키는 **줄 자체는 남기고 값만 비워둬도 된다** — 키가 없는
것과 값이 빈 문자열인 것을 설정 검증이 동일하게 취급한다.

| 키 | 설명 |
|---|---|
| `DATABASE_URL` | 3번에서 마이그레이션에 쓴 것과 **동일한** Supabase 연결 문자열 |
| `DART_API_KEY` | OpenDART 인증키. **정확히 40자여야 한다** — 스키마가 길이를 강제하며, 아니면 워커가 시작하자마자 알아보기 힘든 검증 에러를 내고 죽는다 |
| `TELEGRAM_BOT_TOKEN` | @BotFather에서 발급한 봇 토큰 |
| `TELEGRAM_CHAT_ID` | 공시 알림을 보낼 구독자 채널/챗의 ID |
| `TELEGRAM_OPERATOR_CHAT_ID` | 선택 항목. 설정하면 **일일 다이제스트와 연속 실패 알림만** 이 채널로 간다. 없으면 둘 다 위의 구독자 채널로 간다 — 비공개 단계에서는 구독자가 운영자뿐이라 무방하지만, **공개 전환 전에 반드시 설정해야 한다**. 다이제스트에는 버려진 공시 목록과 내부 카운터가 그대로 들어간다 |
| `LLM_API_KEY` | 요약에 쓰는 LLM API 키. 현재 요약은 꺼져 있지만(본문 조회가 붙는 Task 18까지) 설정 스키마상 **여전히 필수**다 |
| `HEARTBEAT_URL` | 선택 항목 — 6번 참고 |
| `NEWS_ENABLED` | 선택 항목 — **비워두면 꺼짐(`false`)이다.** 뉴스(RSS) 소스를 켠다. 배포와 활성화를 분리하려고 둔 스위치이므로, **뉴스가 채널을 뒤덮으면 이미지를 롤백하지 말고 이 값을 `false`로 되돌린 뒤 컨테이너만 다시 띄운다.** 꺼져 있는 동안 알림 동작은 기존 DART 단일 소스와 같다. 켜져 있으면 기동 로그에 `news source enabled`와 상장사 수가 찍힌다 |
| `NEWS_INTERVAL_MS` | 선택 항목 — **비워두면 기본값 60,000(60초).** RSS 폴링 주기. RSS 반영 지연이 중앙값 3.5분이라 이 값을 줄여도 지연은 거의 안 줄고 대역폭만 는다(30초면 하루 1.2GB, 60초면 0.6GB) |
| `RETENTION_ENABLED` | 선택 항목 — **비워두면 꺼짐(`false`)이다. 켜면 되돌릴 수 없다.** `true`면 매일 KST 자정 이후 첫 사이클에 90일 지난 `events`와 **종결된**(sent/dead) `outbox` 행을 **영구 삭제**한다. 켜기 전에 10번의 백업 워크플로를 최소 한 번 실제로 돌려 아티팩트의 행 수를 확인한다 — 이 프로젝트에 자동 백업은 그것 하나뿐이고, 지운 행은 어디에도 남지 않는다. 꺼져 있으면 기동 로그에 `retention disabled`가 한 줄 찍힌다(침묵이 "꺼짐"인지 "고장"인지 구별하는 신호다) |
| `DART_DAILY_LIMIT` | 선택 항목 — **비워두면 안전하게 기본값 20,000이 적용된다.** 계정에 발급된 일일 호출 한도이며, 기본값은 OpenDART 문서상 기본 한도인 20,000이다. 계정마다 다르게 발급될 수 있으므로(OpenDART 개발가이드의 인증키 신청·관리 메뉴에서 본인 계정의 실제 한도를 확인한다), 더 받았다면(예: 40,000) 그 값을 채워야 폴링이 불필요하게 일찍 느려지지 않는다 |

(`LLM_MODEL`, `LLM_ENDPOINT`는 기본값이 있어 생략 가능하다. 바꿀 때만 채운다.)

## 5. Docker 설치와 실행

```bash
sudo apt-get update && sudo apt-get install -y docker.io
sudo usermod -aG docker "$USER" && newgrp docker

docker run -d --name dart-worker \
  --restart always \
  --stop-timeout 45 \
  --env-file /home/ubuntu/worker.env \
  dart-worker
```

`--restart always`가 crash-only 설계의 한쪽 축이다. 프로세스가 죽으면 Docker가 되살린다.

**`--stop-timeout 45`는 절대 지우지 않는다.** 워커는 SIGTERM을 받으면 진행 중인
사이클을 끝까지 마치고 종료하는데, 텔레그램 호출 타임아웃만 15초, LLM 호출
타임아웃은 30초라 한 사이클이 Docker 기본 유예(10초)보다 길게 걸리는 일이 실제로
있다 — 유예가 끝나 SIGKILL이 사이클 중간에 떨어지면, 텔레그램이 이미 수신한 알림이
`markSent` 처리 전에 죽어 재시작 시 같은 알림이 중복 발송될 수 있다. Docker Compose를
쓴다면 동일한 이유로 서비스에 `stop_grace_period: 45s`를 넣는다.

이건 최초 수동 기동 절차다. 9번부터는 GitHub Actions가 push마다 이 컨테이너를
자동으로 다시 빌드·배포한다 — 그때부터는 이 `docker run`을 손으로 다시 칠 일이
없고, 대신 `deploy/deploy.sh`(메모리 제한과 로그 로테이션이 추가된 버전)가 같은
`--restart always` / `--stop-timeout 45` / `--env-file`을 그대로 적용한다.

## 6. 외부 감시 (시작에는 선택, 무인 운영에는 필수)

`HEARTBEAT_URL`은 설정 스키마상 선택 값이라 없어도 워커는 정상적으로 시작한다.
하지만 이 배포는 **운영자가 실시간으로 대응할 수 없다는 전제**로 하는 것이므로,
하트비트 없이는 프로세스가 조용히 죽거나(OOM, VM 회수 등) 멈춰도 아무도 모른 채
방치된다. 실제 운영에서는 사실상 필수로 취급한다.

Healthchecks.io 류에서 ping URL을 발급받아 `HEARTBEAT_URL`에 넣는다.
**반드시 OCI 외부 서비스여야 한다** — 같은 VM에 두면 VM이 죽을 때 감시도 같이 죽는다.

주기는 폴링 주기보다 넉넉히 잡는다 (예: grace period 10분).

## 7. 로그 확인

```bash
docker logs -f --tail 100 dart-worker
```

## 8. 컨테이너는 떠 있는데 알림이 안 올 때

1. **로그에서 `cycle failed`를 찾는다.**
   ```bash
   docker logs --tail 200 dart-worker | grep "cycle failed"
   ```
   `relation ... does not exist` 류가 보이면 3번의 마이그레이션이 적용되지 않은 것이다.
2. **마이그레이션이 실제로 적용됐는지 Supabase 테이블 목록에서 `events`, `outbox`,
   `api_usage`가 보이는지로 확인한다.**
3. **텔레그램 봇이 채널의 관리자(admin)로 추가돼 있는지 확인한다.** 봇을 멤버로만
   추가하면 발송이 조용히 실패한다.
4. **장 시간 외에는 조용한 것이 정상일 수 있다.** 폴링 주기는 평일 장중(KST
   08:00–18:59) 10초, 그 외 평일 30초, 주말 5분으로 설계돼 있다 — 장 마감 후나
   주말에 알림이 뜸한 것은 버그가 아니다.
5. **CI/CD 배포가 실제로는 실패하고 예전 컨테이너가 그대로 떠 있는 건 아닌지
   확인한다.** GitHub Actions의 `Deploy` 워크플로 실행 기록을 본다 — 특히
   `build-and-push`가 성공했는데 `deploy` 단계에서 SSH가 실패한 경우, 이미지는
   GHCR에 올라갔지만 VM의 컨테이너는 갱신되지 않은 채로 조용히 멈춰 있을 수
   있다. `docker inspect --format '{{.Created}}' market-radar-worker`로 컨테이너
   생성 시각이 최근 배포 시각과 맞는지 확인한다.
6. **GHCR 패키지가 도중에 private로 바뀌지 않았는지 확인한다.** VM은 무인증으로
   `docker pull`하므로, 패키지 가시성이 private로 바뀌면 `deploy` 단계의
   `docker pull`이 그 자리에서 실패한다 (9.3 참고).

## 9. CI/CD (GitHub Actions)

`.github/workflows/ci.yml`은 모든 push(main)와 PR에서 타입체크 → 테스트 →
`apps/worker/Dockerfile` 빌드(푸시 없음)를 검증한다. `.github/workflows/deploy.yml`은
main에 push될 때만 동작하며, **같은 테스트/타입체크 게이트를 다시 통과해야만**
이미지를 GHCR에 빌드·푸시하고 VM에 배포한다 — 테스트가 실패하면 그 시점에서
파이프라인이 멈추고 배포는 일어나지 않는다. PR이나 포크에서는 배포 워크플로 자체가
트리거되지 않는다.

### 9.1 리포지토리 시크릿

GitHub 저장소 **Settings → Secrets and variables → Actions → New repository
secret**에서 아래 세 개만 만든다. VM의 IP나 사용자명, 키는 **절대 레포 파일에
커밋하지 않는다** — 전부 시크릿으로만 존재해야 한다.

| 시크릿 | 값 |
|---|---|
| `DEPLOY_HOST` | VM의 공인 IP 또는 도메인 |
| `DEPLOY_USER` | `ubuntu` |
| `DEPLOY_SSH_KEY` | 9.2에서 만드는 배포 전용 **개인키** 전체 내용 |

GHCR 푸시는 워크플로가 자동으로 받는 `GITHUB_TOKEN`으로 인증한다 — 레포가
public이고 워크플로에 `packages: write` 권한만 주면 되므로 별도 시크릿이
필요 없다.

### 9.2 배포 전용 SSH 키 만들고 제한하기

**로컬(또는 아무 안전한 머신)에서 키 쌍을 만든다.** VM에 이미 쓰고 있는 개인
키와는 분리된, 이 배포 하나에만 쓰는 키다:

```bash
ssh-keygen -t ed25519 -f ./market-radar-deploy -C "market-radar-deploy" -N ""
```

`market-radar-deploy.pub`의 내용을 VM의 `ubuntu` 계정 `~/.ssh/authorized_keys`에
추가하되, 앞에 강제 커맨드를 붙여 **이 키로 할 수 있는 일을 `deploy.sh` 실행
하나로 제한한다**:

```
command="/usr/local/bin/deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA...여기에 공개키... market-radar-deploy
```

- `command="..."` — 이 키로 접속하면 클라이언트가 무슨 명령을 보내든 무시하고
  항상 `/usr/local/bin/deploy.sh`만 실행한다.
- `no-pty` — 대화형 셸을 얻을 수 없다.
- `no-port-forwarding` — 이 키를 발판 삼아 VM 안쪽으로 터널을 뚫을 수 없다.

이렇게 해두면 **`DEPLOY_SSH_KEY`가 유출돼도 공격자가 할 수 있는 일은
`deploy.sh`를 다시 실행하는 것뿐이다** — 셸도, 다른 파일 접근도, 포트 포워딩도
안 된다.

키를 다 넣었으면 `market-radar-deploy`(개인키) 파일 전체 내용을 `DEPLOY_SSH_KEY`
시크릿 값으로 붙여넣고, 로컬에 남은 개인키 사본은 지운다.

### 9.3 GHCR 패키지 공개 설정

레포가 public이므로 이미지(`ghcr.io/choigyeongju/market-radar`)도 public으로
유지해야 VM이 인증 없이 `docker pull`할 수 있다. **`GITHUB_TOKEN`으로 처음 푸시된
패키지는 기본적으로 private로 생성된다** — 첫 `deploy` 실행이 끝난 뒤, 저장소의
**Packages** 탭에서 `market-radar` 패키지를 열어 **Package settings → Change
visibility → Public**으로 바꾸고, 같은 화면에서 이 저장소에 연결(Connect
repository)한다. 이 단계를 건너뛰면 이미지 빌드·푸시는 성공해도 VM의
`docker pull`이 인증 실패로 죽는다.

### 9.4 롤백

`deploy.sh`는 인자로 태그를 받는다 (기본값 `latest`). 자동 배포는 항상
`latest`를 배포하므로, 특정 커밋으로 되돌리려면 **배포 전용 키가 아니라 본인의
평소 SSH 키로** VM에 직접 들어가서 해당 커밋의 SHA 태그를 지정해 다시 실행한다:

```bash
ssh ubuntu@<VM_HOST>
sudo /usr/local/bin/deploy.sh <되돌릴_커밋_SHA>
```

되돌릴 SHA는 GitHub Actions의 `Deploy` 워크플로 실행 목록이나 `git log --oneline`
에서 확인한다. 이미지는 매 배포마다 `latest`와 커밋 SHA 두 태그로 푸시되므로,
과거 어떤 커밋으로도 한 번의 `deploy.sh <sha>` 호출로 되돌릴 수 있다.

### 9.5 배포가 실제로 적용됐는지 확인하기

1. GitHub Actions의 `Deploy` 워크플로 실행이 초록으로 끝났는지 본다.
2. VM에서 컨테이너 생성 시각이 이번 배포 시각과 맞는지 확인한다:
   ```bash
   docker inspect --format '{{.Created}}' market-radar-worker
   ```
3. 실행 중인 이미지의 다이제스트가 방금 푸시된 것과 같은지 확인한다:
   ```bash
   docker inspect --format '{{.Image}}' market-radar-worker
   docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/choigyeongju/market-radar:latest
   ```
4. `docker logs --tail 50 market-radar-worker`에서 새 프로세스의 기동 로그
   (설정 검증 통과, 첫 사이클 시작)가 이번 배포 시점 이후로 찍혔는지 확인한다 —
   오래된 로그만 보인다면 컨테이너가 실제로 교체되지 않은 것이다.

### 9.6 컨테이너는 떠 있는데 알림이 안 올 때

먼저 8번의 체크리스트(마이그레이션, 텔레그램 admin 권한, 장중 여부)를 따라간다.
CI/CD를 도입한 뒤로 추가되는 원인 두 가지는 8번 섹션 끝에 5번·6번 항목으로
넣어뒀다 — 요약하면 **배포가 실제로는 실패했는데 예전 컨테이너가 그대로 떠
있는 경우**와 **GHCR 패키지가 private로 바뀌어 무인증 pull이 실패하는 경우**다.
둘 다 "컨테이너는 떠 있다"는 상태만 보면 정상처럼 보이므로, 알림이 며칠째 뜸하면
컨테이너 상태보다 먼저 `Deploy` 워크플로의 최근 실행 로그부터 본다.

### 9.7 기존 배포를 갱신할 때 — 마이그레이션은 사람이 적용한다

**3번의 마이그레이션 절차는 최초 1회용이 아니다.** `ci.yml`도 `deploy.yml`도
`drizzle-kit migrate`를 돌리지 않는다 — 워크플로가 하는 일은 타입체크·테스트·
이미지 빌드·컨테이너 교체까지다. 즉 **`apps/worker/drizzle/`에 새 `.sql` 파일이
들어간 배포는, 사람이 적용하지 않으면 스키마가 그대로인 채로 새 이미지만 올라간다.**

지금 이 상태인 파일이 하나 있다: `0002_outbox_event_id_idx.sql`
(`outbox.event_id` 인덱스). 적용되지 않아도 워커는 정상 기동하고 알림도 정상으로
나가기 때문에, 빠졌다는 사실이 증상으로 드러나지 않는다 — 보관 정리와
다이제스트의 조인이 조용히 순차 스캔으로 도는 것이 전부다.

**배포 때마다 확인할 것** — main 에 머지하기 전에 이번 변경에 새 마이그레이션이
있는지 본다:

```bash
git diff --name-only origin/main -- apps/worker/drizzle
```

**적용 절차.** 저장소가 있는 아무 머신에서나(배포 대상 VM일 필요 없다), 운영
`DATABASE_URL`로:

```bash
DATABASE_URL="<supabase 연결 문자열>" \
  pnpm --filter @app/worker exec drizzle-kit migrate
```

`drizzle-kit`은 적용 이력을 DB 에 기록하므로 이미 적용된 파일은 건너뛴다 —
여러 번 돌려도 안전하다.

**순서.** 컬럼·인덱스 **추가**처럼 기존 코드와 호환되는(additive) 마이그레이션은
배포 **전에** 적용한다 — 새 이미지가 그 스키마를 기대해도 이미 준비돼 있다.
컬럼 삭제·이름 변경처럼 구 버전 코드를 깨뜨리는 변경은 이 리포의 무중단 전제
(컨테이너 1대, 교체 중 잠깐 내려감)로는 한 번에 못 한다 — 그때는 코드와 DB 를
두 번의 배포로 나눈다.

**큰 테이블의 인덱스 생성은 락을 잡는다.** `CREATE INDEX`(위 0002 포함)는 기본형이
쓰기를 막는다. `events`/`outbox`가 이미 크게 쌓인 뒤에 돌린다면 워커를 잠깐
멈추거나(`docker stop`) 장 시작 전 한산한 시간대를 고른다.

## 10. events 백업과 복구

무료 티어에는 자동 백업이 없다. 뉴스 소스가 붙으면서 `events`는 DB 가 유일본인
데이터가 됐다(스펙 §6.4) — DART 는 API 에서 재수집할 수 있지만 뉴스는 못 하고,
필터가 내린 `verdict`/`rule`은 어디에도 없다. `.github/workflows/backup.yml`이
매주 월요일 KST 03:00 에 `scripts/backup-events.sh`로 `events`를 CSV 로 덤프해
gzip 압축한 뒤 GitHub Actions 아티팩트로 90일(무료 플랜 한도) 보관한다.

`outbox`는 백업 대상이 아니다 — 발송 상태는 재구성 시도가 가능한 값이고, 튜닝
가치가 있는 것은 `events`의 `verdict`/`rule`/`raw`뿐이다.

### 10.1 수동 실행

일정을 기다리지 않고 즉시 백업하려면:

```bash
gh workflow run backup.yml
gh run watch
```

성공하면 그 실행의 Artifacts 에 `events-<run_id>`가 생긴다. **워크플로가
초록이라고 백업이 있다는 뜻은 아니다** — 실제로 받아서 행 수를 확인한다:

```bash
gh run download <run_id> -n events-<run_id>
gunzip -c events.csv.gz | wc -l   # 1 이면 헤더뿐이고 데이터가 0건이라는 뜻
```

### 10.2 이 백업이 잡는 실패, 못 잡는 실패

`scripts/backup-events.sh`는 아래를 스스로 확인해서 실패를 워크플로 실패로
드러낸다 (`set -euo pipefail`에만 기대지 않는다 — `gzip`으로 이어지는 파이프는
그 자체로 상류 실패를 가릴 수 있어서, `psql`/`gzip` 각각의 종료 코드를
`PIPESTATUS`로 직접 확인한다):

- **`psql` 이 실패** (연결 실패, 인증 실패, 쿼리 오류, 타임아웃) — 파이프라인의
  두 종료 코드를 각각 확인해 잡고, 남은 부분 파일을 지운다.
- **`psql` 자체는 러너에 없음** — 백업 job 의 `Ensure psql` 단계가 먼저 설치를
  시도한다. GitHub 러너 이미지에 `postgresql-client`가 있다고 가정하지 않는다.
- **결과가 헤더뿐이고 데이터 행이 0건** — `gzip -9`는 빈 입력을 넣어도 수십
  바이트짜리 유효한 gzip 파일을 만들기 때문에, 파일이 "0바이트가 아님"은 "내용이
  있음"을 보장하지 않는다. 압축을 풀어 헤더를 뺀 실제 행 수를 세서 0건이면
  실패로 취급한다. **주의**: `events`가 아직 한 건도 없는 상태에서(예: 새로
  만든 DB 에 마이그레이션만 적용하고 워커를 아직 안 띄운 경우) 처음 이 워크플로를
  돌리면 이 조건에 정확히 걸려 **의도적으로** 실패한다 — 버그가 아니라 "백업할
  데이터가 아직 없다"는 뜻이다.
- **COPY 가 전송 도중 끊겨 아티팩트가 잘림** — `gzip -t`는 이 경우를 잡지
  **못한다**: 연결이 끊겨도 이미 받은 바이트만으로 gzip 은 구조적으로 멀쩡한
  (짧을 뿐인) 파일을 닫을 수 있고, `gzip -t`는 파일이 쓰인 *이후*의 손상만
  검사하기 때문이다. 실제로 이 경우를 잡는 건 별도의 교차 검증이다: COPY 를
  시작하기 직전에 독립된 연결로 `SELECT count(*) FROM events`를 미리 구해 두고,
  압축을 풀어 센 실제 행 수가 그 사전 카운트보다 적으면 실패로 처리하고 파일을
  지운다. 그 사이 워커가 새 이벤트를 더 넣는 것은 허용한다(사전 카운트보다
  많아지기만 한다) — 유일한 예외는 보관 배치(매일 KST 자정 무렵 1회)가 정확히
  그 순간과 겹쳐 오래된 행을 지우는 경우인데, 이 워크플로의 실행 시각(월요일
  KST 03:00)과 몇 시간 떨어져 있어 실무에서는 사실상 겹치지 않는다.
- `gzip -t`로 파일 자체의 무결성도 검사한다 — 이건 파일이 **쓰인 뒤** 디스크
  오류나 업로드 중 손상처럼 사후에 깨지는 경우를 잡는 것이고, 위의 상류 절단과는
  다른 실패 모드다.

**이 스크립트가 여전히 잡지 못하는 것**: 쿼리는 성공하고 사전 카운트와 실제
행 수가 서로 맞지만 그 내용 자체가 이미 낡은 경우 — 예를 들어 `DATABASE_URL`이
옛 프로젝트를 가리키고 있거나, 워커가 며칠째 죽어서 새 이벤트가 안 들어오고
있는데 과거 행은 여전히 존재하는 경우다. 두 경우 모두 "사전 카운트 = 실제
행 수"라는 조건 자체는 참이므로 워크플로는 초록으로 끝난다. 받은 아티팩트의
최신 `first_seen_at` 값이 최근인지는 사람이 가끔 눈으로 확인해야 한다.

**스크립트가 아니라 워크플로가 안 도는 경우는 더 조용하다.** GitHub 는
**저장소에 60일간 활동이 없으면 `schedule` 트리거 워크플로를 자동으로
비활성화한다.** 커밋도 이슈도 없는 조용한 1인 프로젝트는 이 조건에 정확히
들어맞는다 — 그러면 워크플로는 실패하는 게 아니라 **아예 실행되지 않고**,
실패 알림도 빨간 체크도 없이 유일한 백업 경로가 사라진다. 60일째에 계정
메일로 안내가 오지만 그것뿐이다.

- 두 달에 한 번은 Actions 탭에서 `Backup events` 워크플로가 **비활성화
  상태가 아닌지**, 그리고 마지막 실행이 지난주인지 확인한다.
- 비활성화됐다면 해당 워크플로 페이지의 **Enable workflow** 로 다시 켠다.
- 되살린 뒤에는 `workflow_dispatch`로 한 번 수동 실행해 그 사이 백업이
  없었던 구간을 메운다.
- `RETENTION_ENABLED=true`로 운영 중이라면 이 점검을 건너뛰면 안 된다 —
  백업이 멈춘 채로 삭제만 매일 도는 상태가 되고, 그 조합이 이 프로젝트에서
  데이터를 영구히 잃는 유일한 경로다.

### 10.3 복구

DB 자체가 날아가 새로 만든 경우 먼저 3번의 마이그레이션을 적용한 뒤:

```bash
gunzip -c events.csv.gz > events.csv
psql "$DATABASE_URL" -c "\copy events (
  id, source_id, external_id, occurred_at, first_seen_at,
  title, url, corp_name, ticker, market, verdict, tier, rule, raw
) FROM 'events.csv' WITH CSV HEADER"
```

`id`는 `bigserial`이라 값을 그대로 넣어 복원하면 시퀀스가 삽입된 최댓값을
따라가지 않는다 — 복구 후 반드시 동기화한다:

```sql
SELECT setval(pg_get_serial_sequence('events', 'id'), (SELECT MAX(id) FROM events));
```

**`outbox`는 자동으로 재구성되지 않는다.** 워커가 기동 시 `events.external_id`를
소스별로 최근 `SEEN_CAPACITY`(500)건만 메모리에 올려 재조회를 억제하긴 하지만
(`apps/worker/src/core/seen.ts:26`, `recentExternalIds` — `postgres.ts`), 그건
DB 왕복을 아끼는 캐시일 뿐 `outbox`가 안 살아나는 진짜 이유가 아니다 — 그 500건
밖의 이벤트를 라이브 소스가 다시 돌려줘서 메모리 캐시를 못 거르더라도,
`recordEvent`가 `events`의 `(source_id, external_id)` 유니크 제약에 `ON CONFLICT
DO NOTHING`으로 INSERT 를 시도하고, 복구로 이미 그 행이 존재하므로 항상
충돌해서 `rows[0]`가 비고 `inserted`가 `false`가 된다 — 이 경우 `outbox` INSERT
자체를 건드리지 않고 그대로 반환한다(`apps/worker/src/adapters/store/postgres.ts:60-64`,
`if (!inserted) return false // 중복 — outbox를 건드리지 않는다`). 즉 원래
`outbox` 행이 없어진(=재해 당시 아직 미발송이었던) 이벤트는, 메모리 캐시 크기와
무관하게 재기동만으로는 발송 큐에 다시 들어가지 않는다. 재해 시점에 `pass`
판정인데 미발송이었던 건이 있는지는 복구 직후 아래 질의로 직접 확인한다:

```sql
SELECT id, title, tier FROM events e
WHERE verdict = 'pass'
  AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.event_id = e.id)
ORDER BY first_seen_at DESC LIMIT 50;
```

자동 재발송 경로는 없다 — 필요하면 이 목록을 보고 수동으로 알린다.
