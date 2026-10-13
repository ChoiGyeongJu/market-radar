import { describe, it, expect } from 'vitest'
import {
  decideMacro, MACRO_PARAMS, type MacroCandidate, type MacroFire,
} from './cluster.js'

const NOW = new Date('2026-10-13T00:30:00Z') // 09:30 KST
const min = (m: number) => new Date(NOW.getTime() - m * 60_000)

let nextId = 1
function cand(
  key: string, press: string, seenMinAgo: number,
  opts: { breaking?: boolean; publishedMinAgo?: number; title?: string } = {},
): MacroCandidate {
  const id = nextId++
  return {
    eventId: id,
    key,
    press,
    breaking: opts.breaking ?? false,
    event: {
      sourceId: 'news',
      externalId: `p:${id}`,
      occurredAt: opts.publishedMinAgo === undefined ? null : min(opts.publishedMinAgo),
      firstSeenAt: min(seenMinAgo),
      title: opts.title ?? `${key} ${press}`,
      url: `https://x/${id}`,
      raw: { press },
    },
  }
}

const KOSPI = 'market:코스피:급변'
const NK = 'geo:북한:미사일'

describe('decideMacro — 매체 수', () => {
  it('창 안에서 서로 다른 매체가 3곳이면 발화한다', () => {
    const d = decideMacro([
      cand(KOSPI, '연합뉴스', 20), cand(KOSPI, '매일경제', 10), cand(KOSPI, '조선비즈', 1),
    ], [], NOW)
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ key: KOSPI, trigger: 'presses', outcome: 'sent' })
    expect(d[0]!.presses).toEqual(['연합뉴스', '매일경제', '조선비즈'])
  })

  it('같은 매체가 여러 번 써도 한 곳으로 센다', () => {
    const d = decideMacro([
      cand(KOSPI, '연합뉴스', 20), cand(KOSPI, '연합뉴스', 15), cand(KOSPI, '연합뉴스', 10),
      cand(KOSPI, '매일경제', 5),
    ], [], NOW)
    expect(d).toEqual([])
  })

  it('창 밖의 기사는 세지 않는다', () => {
    const d = decideMacro([
      cand(KOSPI, '연합뉴스', MACRO_PARAMS.windowMs / 60_000 + 1),
      cand(KOSPI, '매일경제', 10), cand(KOSPI, '조선비즈', 1),
    ], [], NOW)
    expect(d).toEqual([])
  })

  it('키가 다르면 같은 사건으로 세지 않는다', () => {
    const d = decideMacro([
      cand(KOSPI, '연합뉴스', 10), cand(NK, '매일경제', 5), cand('market:코스닥:급변', '조선비즈', 1),
    ], [], NOW)
    expect(d).toEqual([])
  })
})

describe('decideMacro — 속보', () => {
  it('속보 한 건이면 매체 수와 무관하게 발화한다 — 2026-10-12 북한 미사일 회귀', () => {
    const d = decideMacro([cand(NK, '연합뉴스', 2, { breaking: true })], [], NOW)
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ key: NK, trigger: 'breaking', outcome: 'sent' })
  })

  it('대표 기사는 속보가 먼저다 — 그다음 연합, 그다음 가장 이른 것', () => {
    const early = cand(KOSPI, '매일경제', 20)
    const yna = cand(KOSPI, '연합뉴스', 15)
    const breaking = cand(KOSPI, '머니투데이', 10, { breaking: true })
    expect(decideMacro([early, yna, breaking], [], NOW)[0]!.representative).toBe(breaking)
    expect(decideMacro([early, yna, cand(KOSPI, '조선비즈', 5)], [], NOW)[0]!.representative).toBe(yna)
    expect(decideMacro(
      [early, cand(KOSPI, '조선비즈', 5), cand(KOSPI, '한국경제', 3)], [], NOW,
    )[0]!.representative).toBe(early)
  })
})

describe('decideMacro — 재발화 억제와 상한', () => {
  it('같은 키는 쿨다운 동안 다시 발화하지 않는다 — 후속 보도가 몇 시간씩 이어진다', () => {
    const fired: MacroFire[] = [{ key: NK, firedAt: min(60), outcome: 'sent' }]
    expect(decideMacro([cand(NK, '연합뉴스', 1, { breaking: true })], fired, NOW)).toEqual([])
  })

  it('쿨다운이 지나면 다시 발화한다', () => {
    const fired: MacroFire[] = [{ key: NK, firedAt: min(MACRO_PARAMS.cooldownMs / 60_000 + 1), outcome: 'sent' }]
    expect(decideMacro([cand(NK, '연합뉴스', 1, { breaking: true })], fired, NOW)).toHaveLength(1)
  })

  it('상한에 걸린(capped) 발화도 쿨다운을 건다 — 안 걸면 매 사이클 다시 capped 로 기록된다', () => {
    const fired: MacroFire[] = [{ key: NK, firedAt: min(30), outcome: 'capped' }]
    expect(decideMacro([cand(NK, '연합뉴스', 1, { breaking: true })], fired, NOW)).toEqual([])
  })

  it('시간당 상한을 넘으면 sent 가 아니라 capped 로 결정한다 — 버린 것도 센다', () => {
    const fired: MacroFire[] = [
      { key: 'a', firedAt: min(50), outcome: 'sent' },
      { key: 'b', firedAt: min(40), outcome: 'sent' },
    ]
    const d = decideMacro([
      cand(KOSPI, '연합뉴스', 10, { breaking: true }),
      cand(NK, '연합뉴스', 5, { breaking: true }),
    ], fired, NOW)
    expect(d.map((x) => [x.key, x.outcome])).toEqual([[KOSPI, 'sent'], [NK, 'capped']])
  })

  it('상한은 sent 만 센다 — capped 이력으로 예산이 줄지 않는다', () => {
    const fired: MacroFire[] = [
      { key: 'a', firedAt: min(50), outcome: 'capped' },
      { key: 'b', firedAt: min(40), outcome: 'capped' },
      { key: 'c', firedAt: min(30), outcome: 'capped' },
    ]
    const d = decideMacro([cand(NK, '연합뉴스', 5, { breaking: true })], fired, NOW)
    expect(d[0]!.outcome).toBe('sent')
  })

  it('한 시간 넘은 발화는 상한에서 빠진다', () => {
    const fired: MacroFire[] = [1, 2, 3].map((i) => ({ key: `k${i}`, firedAt: min(61 + i), outcome: 'sent' as const }))
    expect(decideMacro([cand(NK, '연합뉴스', 5, { breaking: true })], fired, NOW)[0]!.outcome).toBe('sent')
  })

  it('상한 예산은 먼저 시작된 사건부터 쓴다 — 키 이름 순서가 아니다', () => {
    const fired: MacroFire[] = [1, 2].map((i) => ({ key: `k${i}`, firedAt: min(10 + i), outcome: 'sent' as const }))
    const d = decideMacro([
      cand('market:코스피:사이드카', '연합뉴스', 3, { breaking: true }), // 사전순으로는 앞
      cand(NK, '연합뉴스', 20, { breaking: true }), // 먼저 시작됐다
    ], fired, NOW)
    expect(d.find((x) => x.outcome === 'sent')!.key).toBe(NK)
  })
})

describe('decideMacro — 옛 기사', () => {
  it('pubDate 가 한참 전인 기사는 세지 않는다 — 뒤늦게 다시 떠오른 옛 기사다', () => {
    const stale = (MACRO_PARAMS.maxStalenessMs / 60_000) + 10
    expect(decideMacro([cand(NK, '연합뉴스', 1, { breaking: true, publishedMinAgo: stale })], [], NOW))
      .toEqual([])
  })

  it('pubDate 가 미래여도 막지 않는다 — 매일경제가 미래 시각을 준다', () => {
    expect(decideMacro([cand(NK, '매일경제', 1, { breaking: true, publishedMinAgo: -534 })], [], NOW))
      .toHaveLength(1)
  })
})
