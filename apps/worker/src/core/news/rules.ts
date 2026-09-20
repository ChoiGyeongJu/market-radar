import type { NormalizedEvent, Verdict } from '@app/shared'
import { matchCorp, type CorpIndex } from './corp-index.js'
import { NEWS_TIERS } from './keywords.js'

/** 표현 변형을 흡수하기 위해 공백을 지운다 — `계약 체결` 과 `계약체결` 이 같아진다. */
function squash(s: string): string {
  return s.replace(/\s+/g, '')
}

/**
 * 뉴스 판정. DART 와 게이트 구조는 같지만 순서가 다르다 —
 * 종목 연결(게이트 1)이 DART 의 stock_code 게이트에 해당한다.
 *
 * `description` 은 판정에만 쓰고 **반환하지도 저장하지도 않는다**
 * (스펙 §4.3, 저작권). 제목만으로는 "삼성전자, 3분기 실적 발표"가
 * 호실적인지 어닝쇼크인지 알 수 없어 정확도가 크게 떨어진다.
 */
export function evaluateNews(
  event: NormalizedEvent, index: CorpIndex, description: string,
): Verdict {
  // 게이트 1 — 종목 연결. **제목에서만, 공백을 지우지 않고** 찾는다.
  //
  // 제목으로 한정하는 이유는 실측이다(기사 461건). 본문까지 보면 통과분의 절반이
  // 제목에 종목명이 없었고, 그중에는 본문의 모회사가 제목의 실제 주체를 밀어낸
  // 오귀속이 있었다 — "한섬, 자사주 매입·소각" 이 현대백화점으로 잡혔다. 발송
  // 메시지가 제목과 링크뿐이라, 제목에 없는 회사로 알림이 나가면 설명이 안 된다.
  //
  // squash 하지 않는 이유는 공백을 지우면 단어 경계를 넘어 없던 회사명이 만들어지기
  // 때문이다 — "삼성 전자제품" → "삼성전자제품" 은 "삼성전자" 를 포함하고,
  // "현대 차량" 은 "현대차" 를 포함한다. 종목명은 표현 변형이 거의 없어 얻을 것도 없다.
  //
  // 매크로 트랙(3c)이 붙기 전까지 여기서 막힌 것은 전부 drop 이지만, events 에는
  // 그대로 기록되어 3c·3d 튜닝 근거가 된다.
  const corp = matchCorp(event.title, index)
  if (!corp) return { action: 'drop', reason: 'no-corp-match' }

  // 게이트 2 — 영향 키워드. 이쪽은 squash 한다. 뉴스 제목이 자유 형식이라
  // `계약 체결` 과 `계약체결` 을 같게 봐야 한다.
  const titleSq = squash(event.title)
  const fullSq = squash(`${event.title} ${description}`)
  for (const { tier, words } of NEWS_TIERS) {
    // critical 만 제목으로 한정한다. 실측 최악의 오탐이 이 티어였다 — "맥쿼리 가비아
    // 공개매수 무산" 이 본문의 '상장폐지' 때문에 critical 로 나갔다. critical 은 병합을
    // 건너뛰고 즉시 발송되므로 틀렸을 때 가장 비싸다. high/normal 은 본문을 쓴다 —
    // 제목만으로는 "3분기 실적 발표" 가 호실적인지 어닝쇼크인지 알 수 없다.
    const haystack = tier === 'critical' ? titleSq : fullSq
    const hit = words.find((w) => haystack.includes(squash(w)))
    if (hit) return { action: 'pass', tier, rule: `keyword:${hit}` }
  }

  return { action: 'drop', reason: 'no-keyword-match' }
}
