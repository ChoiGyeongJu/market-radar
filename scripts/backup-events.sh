#!/usr/bin/env bash
# events 테이블을 압축 덤프한다. 스펙 §6.4 — 뉴스를 붙이면 DB 가 유일본인 데이터가
# 생긴다. DART 는 API 에서 재수집할 수 있지만 뉴스는 못 하고, 우리가 내린
# verdict/rule/raw 는 어디에도 없다. 무료 티어에는 자동 백업이 없다.
#
# 백업이 가장 알아차리기 어렵게 죽는 방식은 "워크플로는 초록인데 아티팩트가
# 텅 비어 있다"이다 — 그건 백업이 없는 것보다 나쁘다(있다고 믿게 만든다). 그래서
# 이 스크립트는 set -e/pipefail 에만 기대지 않고, psql 실패·빈 덤프·잘린 gzip을
# 각각 명시적으로 확인해서 죽는다.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL이 필요합니다}"
OUT="${1:-events-$(date -u +%Y%m%d).csv.gz}"

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
PSQL_STATUS="${PIPESTATUS[0]}"
GZIP_STATUS="${PIPESTATUS[1]}"
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

# gzip 스트림 자체가 잘리거나 손상됐는지(네트워크가 COPY 도중 끊겼는데 gzip 이
# 이미 받은 바이트만으로 조용히 유효한 파일을 만들어버리는 경우 등) 별도로
# 검사한다. 위의 gunzip 이 이미 스트림을 다 읽었으니 비용은 거의 없다.
if ! gzip -t "$OUT" 2>/dev/null; then
  echo "backup-events: ${OUT} 가 gzip 무결성 검사에 실패했다 — 잘렸거나 손상됐다" >&2
  rm -f "$OUT"
  exit 1
fi

if [ "$ROWS" -eq 0 ]; then
  echo "backup-events: ${OUT} 에 헤더뿐이고 데이터 행이 0건이다 — 성공으로 보고하지 않는다" >&2
  exit 1
fi

echo "wrote $OUT ($(du -h "$OUT" | cut -f1), ${ROWS} rows)"
