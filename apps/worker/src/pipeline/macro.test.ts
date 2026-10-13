import { describe, it, expect, vi } from 'vitest'
import type { NormalizedEvent } from '@app/shared'
import { MACRO_PARAMS } from '../core/news/cluster.js'
import type { EventStore } from '../ports/store.js'
import { MACRO_TIER, runMacro, type MacroDeps } from './macro.js'

const NOW = new Date('2026-10-13T00:50:00Z') // 09:50 KST
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000)
const LONG_AGO = new Date('2026-10-01T00:00:00Z')

function row(id: number, rule: string, press: string, seenMinAgo: number, title = `t${id}`) {
  const event: NormalizedEvent = {
    sourceId: 'news', externalId: `p:${id}`, occurredAt: null, firstSeenAt: ago(seenMinAgo),
    title, url: `https://x/${id}`, raw: { feedId: 'f', press },
  }
  return { eventId: id, rule, event }
}

function deps(
  rows: Awaited<ReturnType<EventStore['macroCandidates']>>,
  fires: Awaited<ReturnType<EventStore['recentMacroFires']>> = [],
) {
  const store = {
    macroCandidates: vi.fn(async () => rows),
    recentMacroFires: vi.fn(async () => fires),
    recordMacroFire: vi.fn(async () => {}),
  }
  const log = { info: vi.fn() }
  return { deps: { store, log } satisfies MacroDeps, store, log }
}

describe('runMacro', () => {
  it('속보 후보면 발화를 기록하고 같은 호출로 outbox 예약을 넘긴다', async () => {
    const { deps: d, store } = deps([
      row(7, 'macro:market:코스피:사이드카', '머니투데이', 1, '[속보] 코스피 매도 사이드카 발동'),
    ])
    const stats = await runMacro(d, NOW, LONG_AGO)

    expect(stats).toEqual({ sent: 1, capped: 0 })
    const [fire, enqueue] = store.recordMacroFire.mock.calls[0]! as unknown as Parameters<EventStore['recordMacroFire']>
    expect(fire).toEqual({
      key: 'market:코스피:사이드카', firedAt: NOW, eventId: 7, presses: 1, trigger: 'breaking', outcome: 'sent',
    })
    expect(enqueue?.tier).toBe(MACRO_TIER)
    expect(enqueue?.expiresAt.getTime()).toBeGreaterThan(NOW.getTime())
    // 발송 메시지가 매체 수를 쓸 수 있게 payload 에 싣는다. 원래 raw(매체명)는 지키며 덧붙인다.
    expect(enqueue?.payload.raw).toEqual({ feedId: 'f', press: '머니투데이', macro: { presses: 1 } })
    expect(enqueue?.payload.title).toBe('[속보] 코스피 매도 사이드카 발동')
  })

  it('매체 수로 발화하면 그 수를 기록한다', async () => {
    const k = 'macro:market:코스피:급변'
    const { deps: d, store } = deps([
      row(1, k, '연합뉴스', 20), row(2, k, '매일경제', 10), row(3, k, '조선비즈', 2),
    ])
    await runMacro(d, NOW, LONG_AGO)
    const [fire] = store.recordMacroFire.mock.calls[0]! as unknown as Parameters<EventStore['recordMacroFire']>
    expect(fire).toMatchObject({ trigger: 'presses', presses: 3, eventId: 1 }) // 대표는 연합
  })

  it('capped 는 기록하되 outbox 에 넣지 않는다', async () => {
    const fires = [1, 2, 3].map((i) => ({ key: `k${i}`, firedAt: ago(10 * i), outcome: 'sent' as const }))
    const { deps: d, store, log } = deps(
      [row(1, 'macro:geo:북한:미사일', '연합뉴스', 1, '[속보] 北 탄도미사일 발사')], fires,
    )
    const stats = await runMacro(d, NOW, LONG_AGO)

    expect(stats).toEqual({ sent: 0, capped: 1 })
    expect(store.recordMacroFire).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'capped' }), null)
    // 버린 것도 남긴다.
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'capped' }), 'macro fire')
  })

  describe('조회 범위', () => {
    it('창의 시작부터 읽는다', async () => {
      const { deps: d, store } = deps([])
      await runMacro(d, NOW, LONG_AGO)
      expect(store.macroCandidates).toHaveBeenCalledWith(new Date(NOW.getTime() - MACRO_PARAMS.windowMs))
    })

    it('콜드 스타트 시각이 창 안이면 그 시각부터 읽는다 — 재기동 백로그를 후보에서 뺀다', async () => {
      const coldStartAt = ago(5)
      const { deps: d, store } = deps([])
      await runMacro(d, NOW, coldStartAt)
      expect(store.macroCandidates).toHaveBeenCalledWith(coldStartAt)
    })

    it('발화 이력은 쿨다운과 한 시간 중 긴 쪽만큼 읽는다', async () => {
      const { deps: d, store } = deps([])
      await runMacro(d, NOW, LONG_AGO)
      expect(store.recentMacroFires).toHaveBeenCalledWith(
        new Date(NOW.getTime() - Math.max(MACRO_PARAMS.cooldownMs, 60 * 60_000)),
      )
    })
  })

  it('매체를 모르는 기사들은 한 곳으로 센다 — 기사마다 따로 세면 매체 수가 부풀어 오발화한다', async () => {
    const k = 'macro:market:코스피:급변'
    const noPress = (id: number) => ({ ...row(id, k, '', 5), event: { ...row(id, k, '', 5).event, raw: {} } })
    const { deps: d, store } = deps([noPress(1), noPress(2), noPress(3)])
    await runMacro(d, NOW, LONG_AGO)
    expect(store.recordMacroFire).not.toHaveBeenCalled()
  })
})
