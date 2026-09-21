export type Market = 'Y' | 'K'
export type Tier = 'critical' | 'high' | 'normal'

export type EventSubject = {
  name: string
  ticker?: string
  market?: Market
}

export type NormalizedEvent = {
  sourceId: string
  externalId: string
  occurredAt: Date | null
  firstSeenAt: Date
  title: string
  url: string
  subject?: EventSubject
  raw: unknown
}

export type Verdict =
  | { action: 'drop'; reason: string }
  | { action: 'pass'; tier: Tier; rule: string }

export function isPass(v: Verdict): v is Extract<Verdict, { action: 'pass' }> {
  return v.action === 'pass'
}

/**
 * 판정 결과. `verdict` 외에 **판정 과정에서 알아낸 주체**를 함께 돌려준다.
 *
 * 뉴스 판정은 상장사명을 매칭해 게이트 1을 통과시키는데, 그 매칭 결과를 버리면
 * events.corp_name/ticker 가 영원히 NULL 로 남는다. 스펙 §6.4 의 논지 — 우리가
 * 내린 판정은 어디에도 없으므로 뉴스 데이터는 재구성이 불가능하다 — 가 정확히
 * 이 값에도 적용된다. 나중에 다시 매칭하려면 이미 사라진 기사에 대해, 신규 상장·
 * 상장폐지·사명 변경으로 달라진 명부를 써야 한다. 스펙 §8 의 3d(주가 라벨링)도
 * ticker 없이는 돌지 않는다.
 *
 * 이벤트를 제자리에서 고치지 않고 판정과 함께 돌려주는 이유는 core 의 순수성이다 —
 * 판정 함수는 입력을 건드리지 않고, 저장 직전에 pipeline 이 복사본을 만든다.
 *
 * DART 처럼 주체가 이미 이벤트에 실려 오는 소스는 이 필드를 비워 두면 된다.
 */
export type Evaluation = { verdict: Verdict; subject?: EventSubject }
