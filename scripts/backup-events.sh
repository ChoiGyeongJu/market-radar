#!/usr/bin/env bash
# events 테이블을 압축 덤프한다. 스펙 §6.4 — 뉴스를 붙이면 DB 가 유일본인 데이터가
# 생긴다. DART 는 API 에서 재수집할 수 있지만 뉴스는 못 하고, 우리가 내린
# verdict/rule/raw 는 어디에도 없다. 무료 티어에는 자동 백업이 없다.
#
# 백업이 가장 알아차리기 어렵게 죽는 방식은 "워크플로는 초록인데 아티팩트가
# 텅 비어 있다(또는 잘려 있다)"이다 — 그건 백업이 없는 것보다 나쁘다(있다고 믿게
# 만든다). 그래서 이 스크립트는 set -e/pipefail 에만 기대지 않고, psql 실패·빈
# 덤프·잘린 덤프를 각각 명시적으로 확인해서 죽는다.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL이 필요합니다}"
OUT="${1:-events-$(date -u +%Y%m%d).csv.gz}"

# COPY 시작 "직전" 시점의 전체 행 수를 별도 연결로 미리 세어 둔다. 이게 바로
# 아래 gzip -t 가 못 잡는 구멍(상류 절단)을 잡는 유일한 장치다 — COPY 연결이
# 전송 도중 끊겨도 이미 받은 바이트만으로 gzip 이 조용히 "구조적으로는 멀쩡한"
# 파일을 닫아버릴 수 있고, gzip -t 는 그걸 손상으로 보지 않는다(파일이 쓰인
# *이후*의 손상만 검사 대상이다).
#
# 이 카운트 이후 워커가 새 이벤트를 더 넣을 순 있으니(그러면 덤프 행 수가 이
# 카운트보다 많아질 뿐이다) 정확히 같은 수를 요구하지 않는다 — "덤프 행 수가
# 이 카운트보다 적으면 실패"로만 비교한다. 유일한 반례는 보관 배치(retention,
# 매일 KST 자정 무렵 1회, apps/worker/src/pipeline/retention.ts)가 정확히 이
# 순간과 겹쳐 오래된 행을 지우는 경우인데, 이 워크플로의 실행 시각(매주 월요일
# KST 03:00)이 자정 직후와 몇 시간 떨어져 있어 실무에서는 사실상 겹치지 않는다.
PRE_COUNT="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -t -A -c 'SELECT count(*) FROM events;' | tr -d '[:space:]')"
if ! [[ "$PRE_COUNT" =~ ^[0-9]+$ ]]; then
  echo "backup-events: 사전 행 수 조회 결과가 숫자가 아니다 (\"${PRE_COUNT}\")" >&2
  exit 1
fi

# gzip 으로 이어지는 파이프는 그 자체로는 psql 의 실패를 가릴 수 있다 — pipefail
# 이 파이프라인 전체 종료 코드는 잡아주지만, 실패 시 부분 파일을 지우고 이유를
# 남기려면 종료 코드를 직접 봐야 한다. set +e 로 잠깐 감싸 PIPESTATUS 를 그대로
# 받는다.
#
# outbox 는 받지 않는다 — 발송 상태는 재구성 가능하고, 튜닝 가치가 있는 것은
# events 의 verdict/rule/raw 뿐이다.
set +e
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "\copy (
  SELECT id, source_id, external_id, occurred_at, first_seen_at,
         title, url, corp_name, ticker, market, verdict, tier, rule, raw
  FROM events ORDER BY id
) TO STDOUT WITH CSV HEADER" | gzip -9 > "$OUT"
# PIPESTATUS 는 배열째 한 번에 복사해야 한다. `X="${PIPESTATUS[0]}"` 같은 대입문도
# 그 자체가 하나의 명령이라 실행되는 순간 PIPESTATUS 를 (0) 한 원소로 덮어쓴다 —
# 그러면 다음 줄의 PIPESTATUS[1] 은 존재하지 않고, set -u 아래에서 "unbound
# variable" 로 죽는다. 실제로 첫 실행이 정확히 이렇게 죽었다(shellcheck 와 세 번의
# 리뷰를 통과한 뒤였다 — 정적 검증으로는 잡히지 않는 런타임 의미론이다).
PIPE_STATUS=("${PIPESTATUS[@]}")
PSQL_STATUS="${PIPE_STATUS[0]}"
GZIP_STATUS="${PIPE_STATUS[1]}"
set -e

if [ "$PSQL_STATUS" -ne 0 ] || [ "$GZIP_STATUS" -ne 0 ]; then
  echo "backup-events: 덤프 파이프라인 실패 (psql=${PSQL_STATUS}, gzip=${GZIP_STATUS}) — ${OUT} 를 지운다" >&2
  rm -f "$OUT"
  exit 1
fi

# 파일 자체가 없거나 0바이트면 gzip 이 아예 아무것도 못 쓴 것이다.
if [ ! -s "$OUT" ]; then
  echo "backup-events: ${OUT} 가 비어 있거나 생성되지 않았다" >&2
  exit 1
fi

# gzip -9 는 빈 입력을 넣어도 수십 바이트짜리 유효한 gzip 스트림을 만든다 — 즉
# "0바이트가 아님"은 "내용이 있음"을 보장하지 않는다. 압축을 풀어 헤더를 제외한
# 실제 행 수를 센다.
ROWS="$(gunzip -c "$OUT" | tail -n +2 | wc -l | tr -d ' ')"

# 이 파일이 쓰인 *이후* 손상됐는지(디스크 오류, 업로드 중 깨짐 등)만 검사한다.
# 전송 도중 끊긴 COPY 가 "짧지만 구조적으로 멀쩡한" gzip 파일을 만드는 경우는
# 이 검사를 통과한다 — 그건 위의 PRE_COUNT 비교가 잡는다.
if ! gzip -t "$OUT" 2>/dev/null; then
  echo "backup-events: ${OUT} 가 gzip 무결성 검사에 실패했다 — 파일이 손상됐다" >&2
  rm -f "$OUT"
  exit 1
fi

if [ "$ROWS" -eq 0 ]; then
  echo "backup-events: ${OUT} 에 헤더뿐이고 데이터 행이 0건이다 — 성공으로 보고하지 않는다" >&2
  rm -f "$OUT"
  exit 1
fi

# 상류 절단의 실제 검사: 덤프에 실제로 담긴 행 수가 시작 전 테이블 행 수보다
# 적으면, COPY 가 도중에 끊겼는데 gzip 이 그 사실을 가린 것이다.
if [ "$ROWS" -lt "$PRE_COUNT" ]; then
  echo "backup-events: 덤프 행 수(${ROWS})가 시작 전 카운트(${PRE_COUNT})보다 적다 — 잘린 덤프로 보고 실패 처리한다" >&2
  rm -f "$OUT"
  exit 1
fi

echo "wrote $OUT ($(du -h "$OUT" | cut -f1), ${ROWS} rows, pre-dump count was ${PRE_COUNT})"
