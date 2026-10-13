import type { NormalizedEvent } from '@app/shared'

/**
 * 거시 트랙의 발송 결정 — 게이트(macro.ts)를 통과한 후보들 중 **언론이 이미 중요하다고
 * 판정한 것**만 고른다(스펙 §3, §5.3). 순수 함수다: 시계·DB 없이 후보와 발화 이력만 본다.
 *
 * 신호는 두 가지이고 어느 하나면 발화한다.
 *
 * 1. **매체 수** — 창 안에서 같은 키를 쓴 서로 다른 매체가 MACRO_MIN_PRESSES 이상.
 *    여러 매체가 동시에 썼다는 것 자체가 언론사들이 대신 해준 중요도 판정이다.
 * 2. **속보 머리표** — 매체 수만으로는 우리 피드 구성에서 지정학 사건을 놓친다. 증권
 *    섹션 피드들은 북한·중동을 싣지 않는다. 실측(2026-10-12): 북한 탄도미사일 발사를
 *    연합이 09:35 [속보]로 낸 뒤 3시간 동안 6건을 더 썼지만, 같은 사건을 실은 다른
 *    매체는 뉴시스 하나뿐이었고 그마저 5시간 뒤였다. 반대로 수집분에서 게이트를
 *    통과한 [속보] 7건은 전부 실제 사건이었다(북한 미사일 2, 코스피 급락 3, 사이드카 2).
 *
 * 같은 키는 MACRO_COOLDOWN_MS 동안 다시 발화하지 않는다 — 큰 사건일수록 후속 보도가
 * 몇 시간씩 이어진다(위 북한 건은 [속보]만 두 번). 채널 전체로는 시간당 MACRO_HOURLY_CAP
 * 건까지만 보낸다. 상한에 걸린 것도 `capped` 로 결정해 기록한다 — **버린 것을 세지
 * 않으면 상한이 적절한지 알 수 없다**(스펙 §3).
 */

/** 같은 사건으로 묶는 시간 창. 실측 RSS 반영 지연 중앙값 3.5분·최대 7.8분의 몇 배. */
export const MACRO_WINDOW_MS = 30 * 60_000
export const MACRO_MIN_PRESSES = 3
export const MACRO_COOLDOWN_MS = 3 * 60 * 60_000
export const MACRO_HOURLY_CAP = 3
/**
 * pubDate 가 firstSeenAt 보다 이만큼 이상 앞선 기사는 후보에서 뺀다. 피드에 뒤늦게
 * 다시 떠오른 옛 기사가 "지금 여러 매체가 썼다"로 세지면 안 된다. pubDate 가 미래인
 * 경우(매일경제, 스펙 §4.3)는 막지 않는다 — 옛 기사가 아니기 때문이다.
 */
export const MACRO_MAX_STALENESS_MS = 3 * 60 * 60_000

export type MacroCandidate = {
  eventId: number
  /** `카테고리:주체:행위` (macro.ts). */
  key: string
  press: string
  breaking: boolean
  /** 발송 메시지를 만들 원본. firstSeenAt·occurredAt 도 여기서 읽는다. */
  event: NormalizedEvent
}

export type MacroFire = { key: string; firedAt: Date; outcome: 'sent' | 'capped' }

export type MacroDecision = {
  key: string
  /** 메시지에 쓸 대표 기사. */
  representative: MacroCandidate
  /** 창 안에서 이 키를 쓴 매체들(중복 없음, 처음 쓴 순서). */
  presses: string[]
  trigger: 'breaking' | 'presses'
  outcome: 'sent' | 'capped'
}

export type MacroParams = {
  windowMs: number
  minPresses: number
  cooldownMs: number
  hourlyCap: number
  maxStalenessMs: number
}

export const MACRO_PARAMS: MacroParams = {
  windowMs: MACRO_WINDOW_MS,
  minPresses: MACRO_MIN_PRESSES,
  cooldownMs: MACRO_COOLDOWN_MS,
  hourlyCap: MACRO_HOURLY_CAP,
  maxStalenessMs: MACRO_MAX_STALENESS_MS,
}

function isStale(c: MacroCandidate, maxStalenessMs: number): boolean {
  const published = c.event.occurredAt
  if (!published) return false
  return c.event.firstSeenAt.getTime() - published.getTime() > maxStalenessMs
}

/**
 * 대표 기사: 가장 먼저 도착한 속보 → 가장 먼저 도착한 연합뉴스 → 가장 먼저 도착한 것.
 * 클러스터 가중치는 권위로 매기고 발송 시점은 가장 먼저 도착한 매체를 기준으로 한다는
 * 스펙 §4.3 의 원칙을 대표 선택에 옮긴 것이다. 연합은 통신사라 제목이 가장 건조하다.
 */
function pickRepresentative(group: readonly MacroCandidate[]): MacroCandidate {
  return group.find((c) => c.breaking)
    ?? group.find((c) => c.press === '연합뉴스')
    ?? group[0]!
}

export function decideMacro(
  candidates: readonly MacroCandidate[],
  recentFires: readonly MacroFire[],
  now: Date,
  params: MacroParams = MACRO_PARAMS,
): MacroDecision[] {
  const since = now.getTime() - params.windowMs
  const live = candidates
    .filter((c) => c.event.firstSeenAt.getTime() >= since && !isStale(c, params.maxStalenessMs))
    .sort((a, b) => a.event.firstSeenAt.getTime() - b.event.firstSeenAt.getTime() || a.eventId - b.eventId)

  const byKey = new Map<string, MacroCandidate[]>()
  for (const c of live) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c])

  const cooling = new Set(
    recentFires
      .filter((f) => now.getTime() - f.firedAt.getTime() < params.cooldownMs)
      .map((f) => f.key),
  )
  let sentLastHour = recentFires
    .filter((f) => f.outcome === 'sent' && now.getTime() - f.firedAt.getTime() < 60 * 60_000)
    .length

  // 먼저 시작된 사건부터 상한 예산을 쓴다 — 키 이름 순서로 정하면 상한에 걸리는 쪽이
  // 사건이 아니라 알파벳으로 정해진다.
  const decisions: MacroDecision[] = []
  for (const [key, group] of byKey) {
    if (cooling.has(key)) continue
    const presses = [...new Set(group.map((c) => c.press))]
    const trigger = group.some((c) => c.breaking)
      ? 'breaking'
      : presses.length >= params.minPresses ? 'presses' : null
    if (trigger === null) continue

    const outcome = sentLastHour < params.hourlyCap ? 'sent' : 'capped'
    if (outcome === 'sent') sentLastHour += 1
    decisions.push({ key, representative: pickRepresentative(group), presses, trigger, outcome })
  }
  return decisions
}
