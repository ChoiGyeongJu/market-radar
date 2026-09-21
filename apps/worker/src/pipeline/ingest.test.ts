import { describe, it, expect, vi } from 'vitest'
import type { NormalizedEvent } from '@app/shared'
import { evaluateDart } from '../core/dart/rules.js'
import type { EventSource } from '../ports/source.js'
import type { EventStore } from '../ports/store.js'
import { createSeenSet } from '../core/seen.js'
import { runIngest, type IngestState, type SourcePlan } from './ingest.js'

const NOW = new Date('2026-09-19T06:30:00Z')

/** 실제 rcept_no 와 같은 고정 길이 14자리 — 사전순 비교가 수치 비교와 일치한다. */
const ID = {
  older: '20260919000100',
  mid: '20260919000200',
  newer: '20260919000300',
} as const

/** 정상 가동 중(집합이 심겨 있고 콜드 스타트가 끝난) 상태. */
function warm(seenIds: string[] = [], capacity?: number): IngestState {
  return { seen: createSeenSet(seenIds, capacity), coldStart: false }
}

function mkEvent(over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sourceId: 'dart',
    externalId: ID.mid,
    occurredAt: NOW,
    firstSeenAt: NOW,
    title: '무상증자결정',
    url: 'https://example.test',
    subject: { name: '샘플', ticker: '005930', market: 'Y' },
    raw: {},
    ...over,
  }
}

function fakeStore(recordReturns = true) {
  const recordEvent = vi.fn<EventStore['recordEvent']>(async () => recordReturns)
  const store = { recordEvent } as unknown as EventStore
  return { store, recordEvent }
}

function fakeSource(events: NormalizedEvent[]): EventSource {
  return { id: 'dart', fetchLatest: async () => events }
}

/** 공시 소스의 계획. 판정은 evaluateDart, 주기 10초, 한도 추적 대상이다. */
function plan(source: EventSource): SourcePlan {
  return {
    source,
    // DART 는 주체가 이미 이벤트에 실려 오므로 판정만 돌려준다.
    evaluate: (e) => ({ verdict: evaluateDart(e) }),
    intervalMs: () => 10_000,
    countsAgainstApiBudget: true,
  }
}

describe('runIngest', () => {
  it('pass 이벤트는 enqueue=true로 기록한다', async () => {
    const { store, recordEvent } = fakeStore()
    const { stats } = await runIngest(
      { plan: plan(fakeSource([mkEvent()])), store }, warm([ID.older]), NOW,
    )

    expect(stats).toMatchObject({ fetched: 1, recorded: 1, enqueued: 1, suppressed: 0 })
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: ID.mid }),
      expect.objectContaining({ action: 'pass', tier: 'critical' }),
      expect.objectContaining({ enqueue: true }),
    )
  })

  it('drop 이벤트도 사유와 함께 기록하되 enqueue하지 않는다', async () => {
    const { store, recordEvent } = fakeStore()
    // '주주명부폐쇄기간또는기준일설정'은 DART 필터 튜닝 2차 패스에서 NOISE_PATTERNS로
    // 옮겨졌다 (apps/worker/src/core/dart/rules.test.ts의 Finding 5 참고) — 이 테스트가
    // 실제로 검증하려는 것은 no-keyword-match 사유 자체이므로, 여전히 어떤 목록에도
    // 없는 감사보고서제출(실측 12건)로 픽스처를 교체한다.
    const { stats } = await runIngest(
      { plan: plan(fakeSource([mkEvent({ title: '감사보고서제출' })])), store },
      warm([ID.older]),
      NOW,
    )

    expect(stats).toMatchObject({ recorded: 1, enqueued: 0 })
    expect(recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      { action: 'drop', reason: 'no-keyword-match' },
      { enqueue: false, expiresAt: null },
    )
  })

  it('중복은 duplicated로 집계한다', async () => {
    const { store } = fakeStore(false)
    const { stats } = await runIngest(
      { plan: plan(fakeSource([mkEvent()])), store }, warm([ID.older]), NOW,
    )
    expect(stats).toMatchObject({ recorded: 0, duplicated: 1 })
  })

  it('빈 응답도 안전하게 처리한다', async () => {
    const { store } = fakeStore()
    const { stats } = await runIngest({ plan: plan(fakeSource([])), store }, warm([ID.older, ID.mid]), NOW)
    expect(stats).toEqual({
      fetched: 0, skipped: 0, recorded: 0, enqueued: 0, suppressed: 0, duplicated: 0,
    })
  })

  it('판정 함수를 주입받는다 — 소스마다 룰이 다르다', async () => {
    const { store, recordEvent } = fakeStore()
    const source = fakeSource([
      { sourceId: 'news', externalId: 'n1', occurredAt: null, firstSeenAt: new Date(),
        title: '아무 제목', url: 'https://x/1', raw: {} },
    ])
    const alwaysPass = () =>
      ({ verdict: { action: 'pass', tier: 'high', rule: 'test' } }) as const
    await runIngest(
      { plan: { source, evaluate: alwaysPass, intervalMs: () => 30_000, countsAgainstApiBudget: false }, store },
      { seen: createSeenSet([]), coldStart: false },
      new Date(),
    )
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: 'n1' }),
      { action: 'pass', tier: 'high', rule: 'test' },
      expect.objectContaining({ enqueue: true }),
    )
  })

  /**
   * 판정이 알아낸 주체를 저장까지 흘려보낸다. 뉴스 판정은 상장사를 매칭해 게이트를
   * 통과시키는데 그 결과를 버리면 events.corp_name/ticker 가 전부 NULL 이 되고,
   * 그 값은 나중에 복구할 수 없다 — 기사는 사라지고 명부는 변한다(스펙 §6.4).
   */
  describe('판정이 돌려준 주체를 저장 이벤트에 붙인다', () => {
    const newsEvent: NormalizedEvent = {
      sourceId: 'news', externalId: 'yna:1', occurredAt: null, firstSeenAt: NOW,
      title: '한미약품 수주 계약', url: 'https://news.test/1', raw: {},
    }

    it('subject 를 돌려주면 recordEvent 가 그 subject 를 실은 이벤트를 받는다', async () => {
      const { store, recordEvent } = fakeStore()
      const evaluate = () =>
        ({
          verdict: { action: 'pass', tier: 'high', rule: 'keyword:수주' },
          subject: { name: '한미약품', ticker: '128940' },
        }) as const

      await runIngest(
        {
          plan: {
            source: { id: 'news', fetchLatest: async () => [newsEvent] },
            evaluate, intervalMs: () => 60_000, countsAgainstApiBudget: false,
          },
          store,
        },
        warm(),
        NOW,
      )

      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          externalId: 'yna:1',
          subject: { name: '한미약품', ticker: '128940' },
        }),
        expect.anything(),
        expect.anything(),
      )
    })

    it('drop 판정이어도 붙인다 — 튜닝 후보 목록에 회사명이 필요한 쪽은 오히려 이쪽이다', async () => {
      const { store, recordEvent } = fakeStore()
      const evaluate = () =>
        ({
          verdict: { action: 'drop', reason: 'no-keyword-match' },
          subject: { name: '한미약품', ticker: '128940' },
        }) as const

      await runIngest(
        {
          plan: {
            source: { id: 'news', fetchLatest: async () => [newsEvent] },
            evaluate, intervalMs: () => 60_000, countsAgainstApiBudget: false,
          },
          store,
        },
        warm(),
        NOW,
      )

      expect(recordEvent.mock.calls[0]![0].subject).toEqual({ name: '한미약품', ticker: '128940' })
    })

    it('원본 이벤트를 제자리에서 고치지 않는다 — 소스가 만든 객체를 건드리지 않는다', async () => {
      const { store } = fakeStore()
      const evaluate = () =>
        ({
          verdict: { action: 'drop', reason: 'no-keyword-match' },
          subject: { name: '한미약품', ticker: '128940' },
        }) as const

      await runIngest(
        {
          plan: {
            source: { id: 'news', fetchLatest: async () => [newsEvent] },
            evaluate, intervalMs: () => 60_000, countsAgainstApiBudget: false,
          },
          store,
        },
        warm(),
        NOW,
      )

      expect(newsEvent.subject).toBeUndefined()
    })

    it('subject 가 없으면 이벤트를 그대로 넘긴다 — DART 는 이미 주체를 싣고 온다', async () => {
      const { store, recordEvent } = fakeStore()
      const dartEvent = mkEvent()

      await runIngest({ plan: plan(fakeSource([dartEvent])), store }, warm(), NOW)

      expect(recordEvent.mock.calls[0]![0]).toBe(dartEvent)
      expect(recordEvent.mock.calls[0]![0].subject)
        .toEqual({ name: '샘플', ticker: '005930', market: 'Y' })
    })
  })
})

/**
 * C2 회귀 — 목록 API는 날짜 창 없이 매번 같은 최신 100건을 돌려주므로, 마크가 없으면
 * 그 100건 전부가 recordEvent(= 트랜잭션 1개씩)로 간다. 장중 10초 주기에서 하루 약 40만
 * 트랜잭션이고 99%가 유니크 충돌 no-op 이다 — 순수한 낭비이면서, 주기를 다시 조일 때
 * 가장 먼저 막히는 지점이기도 하다.
 */
describe('runIngest — 이미 본 공시 집합', () => {
  it('집합에 있는 이벤트는 store 를 아예 호출하지 않는다', async () => {
    const { store, recordEvent } = fakeStore()
    const events = [
      mkEvent({ externalId: ID.older }),
      mkEvent({ externalId: ID.mid }),
    ]

    const { stats } = await runIngest({ plan: plan(fakeSource(events)), store }, warm([ID.older, ID.mid]), NOW)

    expect(stats).toMatchObject({ fetched: 2, skipped: 2, recorded: 0 })
    expect(recordEvent).not.toHaveBeenCalled() // 트랜잭션 0건
  })

  it('처음 보는 이벤트만 처리한다 — 나머지 99건은 DB를 건드리지 않는다', async () => {
    const { store, recordEvent } = fakeStore()
    const events = [
      mkEvent({ externalId: ID.newer }),
      mkEvent({ externalId: ID.mid }),
      mkEvent({ externalId: ID.older }),
    ]

    const { stats } = await runIngest({ plan: plan(fakeSource(events)), store }, warm([ID.older, ID.mid]), NOW)

    expect(stats).toMatchObject({ fetched: 3, skipped: 2, recorded: 1 })
    expect(recordEvent).toHaveBeenCalledTimes(1)
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: ID.newer }),
      expect.anything(),
      expect.anything(),
    )
  })

  it('처리한 id 를 집합에 담는다', async () => {
    const { store } = fakeStore()
    const events = [mkEvent({ externalId: ID.newer }), mkEvent({ externalId: ID.mid })]

    const { state } = await runIngest({ plan: plan(fakeSource(events)), store }, warm([ID.older]), NOW)

    expect(state.seen.has(ID.newer)).toBe(true)
    expect(state.seen.has(ID.mid)).toBe(true)
    expect(state.seen.has(ID.older)).toBe(true) // 심어둔 것도 그대로 남는다
  })

  it('갱신된 집합은 다음 사이클에서 같은 목록 전체를 걸러낸다 — 정상 상태 트랜잭션 0건', async () => {
    const { store, recordEvent } = fakeStore()
    const events = [mkEvent({ externalId: ID.newer }), mkEvent({ externalId: ID.mid })]
    const source = fakeSource(events)

    const first = await runIngest({ plan: plan(source), store }, warm([ID.older]), NOW)
    recordEvent.mockClear()

    // 목록 API가 같은 100건을 다시 돌려주는 상황 그대로.
    const second = await runIngest({ plan: plan(source), store }, first.state, NOW)

    expect(second.stats).toMatchObject({ fetched: 2, skipped: 2, recorded: 0 })
    expect(recordEvent).not.toHaveBeenCalled()
  })

  it(
    '내림차순 목록에서도 한 사이클 안의 신규 건을 전부 처리한다',
    async () => {
      const { store, recordEvent } = fakeStore()
      // 최신순(내림차순). 셋 다 마크보다 크므로 셋 다 처리되어야 한다.
      const events = [
        mkEvent({ externalId: ID.newer }),
        mkEvent({ externalId: ID.mid }),
        mkEvent({ externalId: '20260919000150' }),
      ]

      const { stats } = await runIngest({ plan: plan(fakeSource(events)), store }, warm([ID.older]), NOW)

      expect(stats).toMatchObject({ fetched: 3, skipped: 0, recorded: 3 })
      expect(recordEvent).toHaveBeenCalledTimes(3)
    },
  )

  it(
    '나중 사이클에 더 작은 externalId 가 와도 처리한다 — ' +
      'rcept_no 는 접수 시각에 부여되지만 공개는 심사를 거치므로 접수 순서와 공개 ' +
      '순서가 다르다. 10:00 접수(작은 번호)가 10:10 에 공개되고 10:05 접수(큰 번호)가 ' +
      '10:06 에 공개되면, 큰 번호가 먼저 도착해 작은 번호를 영영 건너뛰게 만든다.',
    async () => {
      const { store, recordEvent } = fakeStore()

      // 1사이클 — 10:05 접수(번호가 큼)가 먼저 공개됐다.
      const first = await runIngest(
        { plan: plan(fakeSource([mkEvent({ externalId: ID.newer })])), store }, warm(), NOW,
      )
      expect(first.stats.recorded).toBe(1)
      recordEvent.mockClear()

      // 2사이클 — 10:00 접수(번호가 작음)가 심사를 거쳐 뒤늦게 공개됐다.
      const second = await runIngest(
        { plan: plan(fakeSource([mkEvent({ externalId: ID.mid })])), store }, first.state, NOW,
      )

      // 알림을 잃지 않는 것이 이 시스템의 첫 번째 약속이다. 조용한 영구 누락은
      // 아무도 눈치채지 못하는 방식으로 그 약속을 깬다.
      expect(second.stats.recorded).toBe(1)
      expect(recordEvent).toHaveBeenCalledTimes(1)
    },
  )

  it(
    '같은 100건이 여러 사이클 반복돼도 첫 사이클 이후 recordEvent 호출이 0건이다 — ' +
      '목록 API 가 날짜 창 없이 매번 같은 최신 100건을 돌려주기 때문에 이게 핵심이다',
    async () => {
      const { store, recordEvent } = fakeStore()
      const batch = Array.from({ length: 100 }, (_, i) =>
        mkEvent({ externalId: `20260919${String(500 + i).padStart(6, '0')}` }))
      const source = fakeSource(batch)

      let state = warm()
      const perCycle: number[] = []
      for (let i = 0; i < 4; i += 1) {
        recordEvent.mockClear()
        const r = await runIngest({ plan: plan(source), store }, state, NOW)
        perCycle.push(recordEvent.mock.calls.length)
        state = r.state
      }

      expect(perCycle).toEqual([100, 0, 0, 0])
    },
  )

  it(
    '상한을 넘으면 가장 오래된 id 가 축출되고, 다시 나타나면 재처리된다 — ' +
      '유니크 제약이 재삽입을 no-op 으로 만들어 주므로 안전하다',
    async () => {
      const { store, recordEvent } = fakeStore()
      // 상한 2. 처음엔 older 하나만 들어 있다.
      let state = warm([ID.older], 2)

      // mid, newer 를 처리하면 상한 2를 넘겨 가장 오래된 older 가 밀려난다.
      state = (await runIngest(
        { plan: plan(fakeSource([mkEvent({ externalId: ID.mid })])), store }, state, NOW,
      )).state
      state = (await runIngest(
        { plan: plan(fakeSource([mkEvent({ externalId: ID.newer })])), store }, state, NOW,
      )).state

      expect(state.seen.size).toBe(2)
      expect(state.seen.has(ID.older)).toBe(false) // 축출됐다
      expect(state.seen.has(ID.newer)).toBe(true)

      // 축출된 older 가 다시 목록에 나타나면 재처리된다.
      recordEvent.mockClear()
      const again = await runIngest(
        { plan: plan(fakeSource([mkEvent({ externalId: ID.older })])), store }, state, NOW,
      )

      expect(again.stats.recorded).toBe(1)
      expect(recordEvent).toHaveBeenCalledTimes(1)
    },
  )

  it('집합이 비면(빈 DB) 아무것도 건너뛰지 않는다', async () => {
    const { store, recordEvent } = fakeStore()
    const events = [mkEvent({ externalId: ID.older }), mkEvent({ externalId: ID.newer })]

    const { stats, state } = await runIngest(
      { plan: plan(fakeSource(events)), store }, warm(), NOW,
    )

    expect(stats).toMatchObject({ skipped: 0, recorded: 2 })
    expect(recordEvent).toHaveBeenCalledTimes(2)
    expect(state.seen.size).toBe(2)
  })
})

/**
 * C1 회귀 — 스펙 §6.4 의 재기동 폭탄 방지. 예전 구현은 `isTooOld(firstSeenAt, now)` 였는데
 * 어댑터가 `firstSeenAt = now` 로 스탬프를 찍고 같은 `now` 로 비교해 경과 시간이 항상 0ms 였다.
 * 그 게이트는 한 번도 발동할 수 없었다 — 여기서 검증하는 콜드 스타트 억제가 진짜 게이트 8이다.
 */
describe('runIngest — 콜드 스타트 억제', () => {
  const cold = (): IngestState => ({ seen: createSeenSet([ID.older]), coldStart: true })

  it('첫 사이클은 pass 여도 기록만 하고 한 건도 enqueue 하지 않는다', async () => {
    const { store, recordEvent } = fakeStore()
    const events = [
      mkEvent({ externalId: ID.mid }),
      mkEvent({ externalId: ID.newer }),
    ]

    const { stats } = await runIngest({ plan: plan(fakeSource(events)), store }, cold(), NOW)

    expect(stats).toMatchObject({ fetched: 2, recorded: 2, enqueued: 0, suppressed: 2 })
    for (const call of recordEvent.mock.calls) {
      expect(call[2]).toEqual({ enqueue: false, expiresAt: null })
    }
  })

  it('억제해도 판정 자체는 pass 그대로 기록한다 — 룰 튜닝 데이터를 오염시키지 않는다', async () => {
    const { store, recordEvent } = fakeStore()

    await runIngest({ plan: plan(fakeSource([mkEvent({ externalId: ID.mid })])), store }, cold(), NOW)

    expect(recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'pass', tier: 'critical' }),
      { enqueue: false, expiresAt: null },
    )
  })

  it('첫 사이클이 끝나면 coldStart 가 내려간다', async () => {
    const { store } = fakeStore()
    const { state } = await runIngest(
      { plan: plan(fakeSource([mkEvent({ externalId: ID.mid })])), store }, cold(), NOW,
    )
    expect(state.coldStart).toBe(false)
  })

  it('두 번째 사이클부터는 마크 위의 신규 건을 정상 발송한다', async () => {
    const { store, recordEvent } = fakeStore()
    const source = fakeSource([mkEvent({ externalId: ID.mid })])

    const first = await runIngest({ plan: plan(source), store }, cold(), NOW)
    expect(first.stats.enqueued).toBe(0)

    recordEvent.mockClear()
    const second = await runIngest(
      { plan: plan(fakeSource([mkEvent({ externalId: ID.newer })])), store }, first.state, NOW,
    )

    expect(second.stats).toMatchObject({ enqueued: 1, suppressed: 0 })
    expect(recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ enqueue: true }),
    )
  })

  it(
    '억제 사이클에서는 TTL(expiresAt)을 계산하지 않는다 — ' +
      '발송하지 않을 건에 만료 시각을 달면 outbox 에 없는 행의 TTL 을 따지게 된다',
    async () => {
      const { store, recordEvent } = fakeStore()
      await runIngest({ plan: plan(fakeSource([mkEvent({ externalId: ID.mid })])), store }, cold(), NOW)
      expect(recordEvent.mock.calls[0]?.[2]).toMatchObject({ expiresAt: null })
    },
  )

  it('콜드 스타트여도 이미 본 id 는 여전히 건너뛴다 — 억제와 집합은 독립적이다', async () => {
    const { store, recordEvent } = fakeStore()
    const { stats } = await runIngest(
      { plan: plan(fakeSource([mkEvent({ externalId: ID.older })])), store }, cold(), NOW,
    )
    expect(stats).toMatchObject({ skipped: 1, recorded: 0 })
    expect(recordEvent).not.toHaveBeenCalled()
  })
})
