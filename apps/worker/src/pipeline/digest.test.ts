import { describe, it, expect, vi } from 'vitest'
import type { EventStore } from '../ports/store.js'
import type { Notifier } from '../ports/notifier.js'
import { MAX_DIGEST_ATTEMPTS } from '../core/digest.js'
import { catchUpDigests, restoreLastDigestDate, type DigestAttempt, type DigestLogger } from './digest.js'

function deps(
  digestFor: EventStore['digestFor'], send: Notifier['send'], log?: DigestLogger,
  recordDigest: EventStore['recordDigest'] = vi.fn(async () => {}),
) {
  const store = {
    digestFor,
    getApiUsage: async () => 0,
    recordDigest,
  } as unknown as EventStore
  return {
    store, notifier: { send }, sourceId: 'dart', log: log ?? { error: vi.fn() }, dailyLimit: 20_000,
  }
}

const emptyAgg = {
  sent: { critical: 0, high: 0, normal: 0 },
  dead: 0,
  missedCandidates: [],
  errorCounts: {},
  missedTotal: 0,
}

describe('catchUpDigests — 장애가 자정을 두 번 넘겨도 중간 날을 잃지 않는다', () => {
  it('lastDigestDate 가 하루 뒤처지면 하루치만 보낸다', async () => {
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn(async () => ({ ok: true }) as const)
    const next = await catchUpDigests(deps(digestFor, send), '2026-09-18', '2026-09-19', null)

    expect(next.lastDigestDate).toBe('2026-09-19')
    expect(next.digestAttempt).toBeNull()
    expect(digestFor).toHaveBeenCalledTimes(1)
    // 날짜뿐 아니라 소스도 넘겨야 한다 — 집계 전체가 이 조건으로 걸린다.
    expect(digestFor).toHaveBeenCalledWith('2026-09-18', 'dart')
  })

  it('lastDigestDate 가 이틀 뒤처지면 두 번의 runDigest 호출을 날짜 순서대로 보낸다', async () => {
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn(async () => ({ ok: true }) as const)
    const next = await catchUpDigests(deps(digestFor, send), '2026-09-17', '2026-09-19', null)

    expect(next.lastDigestDate).toBe('2026-09-19')
    expect(digestFor).toHaveBeenCalledTimes(2)
    // 순서가 중요하다 — 호출 인자 배열 자체가 순서를 담는다
    expect(digestFor.mock.calls.map((c) => c[0])).toEqual(['2026-09-17', '2026-09-18'])
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('lastDigestDate 가 currentKstDate 와 같으면 아무것도 보내지 않는다', async () => {
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn(async () => ({ ok: true }) as const)
    const next = await catchUpDigests(deps(digestFor, send), '2026-09-19', '2026-09-19', null)

    expect(next.lastDigestDate).toBe('2026-09-19')
    expect(digestFor).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('월 경계를 넘어 밀렸어도 날짜를 하루씩 정확히 따라잡는다', async () => {
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn(async () => ({ ok: true }) as const)
    const next = await catchUpDigests(deps(digestFor, send), '2026-01-30', '2026-02-02', null)

    expect(next.lastDigestDate).toBe('2026-02-02')
    expect(digestFor.mock.calls.map((c) => c[0])).toEqual(['2026-01-30', '2026-01-31', '2026-02-01'])
  })

  it(
    'lastDigestDate 가 currentKstDate 보다 앞서면(시계 스큐·오래된 상태) 아무것도 보내지 않고 즉시 끝난다',
    async () => {
      // 회귀 테스트: `!==` 비교였다면 이 조건은 영원히 거짓이 되지 않아 무한 루프에
      // 빠진다 — 다이제스트를 영원히 발송한다. 짧은 타임아웃을 걸어, 회귀가 나면
      // 이 테스트가 행(hang) 대신 실패로 끝나게 한다.
      const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
      const send = vi.fn(async () => ({ ok: true }) as const)
      const next = await catchUpDigests(deps(digestFor, send), '2026-09-20', '2026-09-19', null)

      expect(next.lastDigestDate).toBe('2026-09-20') // 원래 값 그대로 — 억지로 오늘 날짜로 되돌리지 않는다
      expect(digestFor).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
    },
    1_000,
  )
})

/**
 * I3 회귀 — send() 결과를 버리면, 4096자 초과·429·네트워크 오류로 거부된
 * 다이제스트가 조용히 사라지고 날짜만 전진해 그날의 기록이 영영 없어진다.
 */
describe('catchUpDigests — 발송에 실패하면 날짜를 전진시키지 않는다', () => {
  const failed = { ok: false, retryAfterMs: null, error: 'MESSAGE_TOO_LONG' } as const

  it('실패하면 같은 날짜를 그대로 돌려줘 다음 사이클이 재시도한다', async () => {
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn(async () => failed)
    const next = await catchUpDigests(deps(digestFor, send), '2026-09-18', '2026-09-19', null)

    expect(next.lastDigestDate).toBe('2026-09-18') // 전진하지 않는다
    expect(next.digestAttempt).toEqual({ date: '2026-09-18', attempts: 1 })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('밀린 날짜 중간에서 실패하면 성공한 날까지만 전진한다', async () => {
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn<Notifier['send']>()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(failed)
    const next = await catchUpDigests(deps(digestFor, send), '2026-09-17', '2026-09-20', null)

    // 17일은 나갔고 18일에서 막혔다 — 18일부터 다시 시작한다.
    expect(next.lastDigestDate).toBe('2026-09-18')
    expect(digestFor.mock.calls.map((c) => c[0])).toEqual(['2026-09-17', '2026-09-18'])
  })

  it('자체 레이트 리밋도 실패로 취급해 재시도한다 — 다음 사이클에 자연히 풀린다', async () => {
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn(async () => (
      { ok: false, retryAfterMs: 4_000, error: 'local-rate-limit' } as const
    ))
    const next = await catchUpDigests(deps(digestFor, send), '2026-09-18', '2026-09-19', null)
    expect(next.lastDigestDate).toBe('2026-09-18')
  })
})

/**
 * 파킹된 결함 — catchUpDigests 는 실패 시 날짜를 전진시키지 않는 것까지만
 * 고쳐졌고, 포기 경로가 없었다. 운영자 chat id 가 틀렸거나 길이 상한을 넘긴
 * 뒤에도 영원히 못 보내는 다이제스트가 있으면 매 사이클(장중 10초) 영원히
 * 재시도하며 운영자 채널의 레이트리밋 예산을 태우고, 같은 토큰 버킷을 쓰는
 * 연속 실패 알림까지 지연시킨다. outbox 의 MAX_ATTEMPTS·markDead 와 같은 모양의
 * 상한을 붙인다.
 */
describe('catchUpDigests — 영원히 보낼 수 없는 다이제스트는 한도에서 포기한다', () => {
  const failed = { ok: false, retryAfterMs: null, error: 'MESSAGE_TOO_LONG' } as const

  it('정확히 MAX_DIGEST_ATTEMPTS 번째 실패에서 포기하고 그 날짜를 지나 전진한다', async () => {
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn<Notifier['send']>(async () => failed)
    const d = deps(digestFor, send)

    let attempt: DigestAttempt | null = null
    let result
    for (let i = 0; i < MAX_DIGEST_ATTEMPTS; i += 1) {
      result = await catchUpDigests(d, '2026-09-18', '2026-09-19', attempt)
      attempt = result.digestAttempt
    }

    expect(result!.lastDigestDate).toBe('2026-09-19') // 막힌 날짜를 지나 전진했다
    expect(result!.digestAttempt).toBeNull() // 카운터도 리셋된다
    // 실패한 다이제스트 MAX_DIGEST_ATTEMPTS 회 + 포기 통지 1회
    expect(send).toHaveBeenCalledTimes(MAX_DIGEST_ATTEMPTS + 1)
    expect(send.mock.calls[MAX_DIGEST_ATTEMPTS]?.[0]).toContain('2026-09-18')
  })

  it('한도 미만이면 전진하지 않는다 — 기존 재시도 동작이 회귀하지 않는다', async () => {
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn(async () => failed)
    const d = deps(digestFor, send)

    let attempt: DigestAttempt | null = null
    let result
    for (let i = 0; i < MAX_DIGEST_ATTEMPTS - 1; i += 1) {
      result = await catchUpDigests(d, '2026-09-18', '2026-09-19', attempt)
      attempt = result.digestAttempt
    }

    expect(result!.lastDigestDate).toBe('2026-09-18') // 아직 전진하지 않는다
    expect(result!.digestAttempt).toEqual({ date: '2026-09-18', attempts: MAX_DIGEST_ATTEMPTS - 1 })
    // 포기 통지는 아직 나가지 않았다
    expect(send).toHaveBeenCalledTimes(MAX_DIGEST_ATTEMPTS - 1)
  })

  it('중간에 성공하면 카운터가 리셋되어 다음 실패가 새 예산을 받는다', async () => {
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn<Notifier['send']>()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce({ ok: true }) // 세 번째에 성공 — 리셋
    const d = deps(digestFor, send)

    // currentKstDate 를 18일로 두어, 17일이 성공해 18일로 전진하는 순간 while
    // 루프 조건(date < currentKstDate)이 거짓이 되어 그 호출 안에서 18일치까지
    // 이어서 시도하지 않는다 — 그러면 두 번째 phase 의 실패 횟수 집계와 섞인다.
    let attempt: DigestAttempt | null = null
    for (let i = 0; i < 3; i += 1) {
      const result = await catchUpDigests(d, '2026-09-17', '2026-09-18', attempt)
      attempt = result.digestAttempt
    }

    // 세 번째 호출에서 17일이 성공해 18일로 넘어갔고, 카운터는 리셋된 채다.
    expect(attempt).toBeNull()

    // 리셋 이후 18일이 새로 MAX_DIGEST_ATTEMPTS 번 실패해야 포기한다 — 이전
    // 실패 횟수가 이어졌다면 더 적은 횟수에서 포기했을 것이다.
    send.mockImplementation(async () => failed)
    let result
    for (let i = 0; i < MAX_DIGEST_ATTEMPTS - 1; i += 1) {
      result = await catchUpDigests(d, '2026-09-18', '2026-09-19', attempt)
      attempt = result!.digestAttempt
    }
    expect(result!.lastDigestDate).toBe('2026-09-18') // 아직 포기 전
    expect(result!.digestAttempt).toEqual({ date: '2026-09-18', attempts: MAX_DIGEST_ATTEMPTS - 1 })
  })

  it(
    '포기 통지 발송이 실패해도 던지거나 멈추지 않는다',
    async () => {
      const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
      // 다이제스트 본문도, 포기 통지도 둘 다 실패하는 최악의 경우
      const send = vi.fn(async () => failed)
      const d = deps(digestFor, send)

      let attempt: DigestAttempt | null = null
      let result
      // await 이 그대로 던지면(회귀) 테스트가 실패로 끝난다 — 통과 자체가 증거다.
      for (let i = 0; i < MAX_DIGEST_ATTEMPTS; i += 1) {
        result = await catchUpDigests(d, '2026-09-18', '2026-09-19', attempt)
        attempt = result.digestAttempt
      }

      expect(result!.lastDigestDate).toBe('2026-09-19')
      expect(result!.digestAttempt).toBeNull()
    },
    1_000,
  )
})

/**
 * 재기동 중복 발송 회귀. lastDigestDate 를 마지막 이벤트 날짜에서 복원하던 때는
 * 공시가 없는 날(주말·공휴일) 뒤에 재기동하면 이미 보낸 날짜를 다시 보냈다 —
 * 2026-10-11(일) 재기동에서 마지막 공시가 10-08(목)이라 10-08~10-10 다이제스트
 * 3건이 중복 발송됐다. 끝낸 날짜를 digest_log 에 남기고 거기서 복원한다.
 */
describe('catchUpDigests — 끝낸 날짜를 digest_log 에 남긴다', () => {
  const failed = { ok: false, retryAfterMs: null, error: 'MESSAGE_TOO_LONG' } as const

  it('보낸 날짜마다 순서대로 sent 로 기록한다', async () => {
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn(async () => ({ ok: true }) as const)
    const recordDigest = vi.fn<EventStore['recordDigest']>(async () => {})
    await catchUpDigests(deps(digestFor, send, undefined, recordDigest), '2026-10-08', '2026-10-11', null)

    expect(recordDigest.mock.calls).toEqual([
      ['dart', '2026-10-08', 'sent'],
      ['dart', '2026-10-09', 'sent'],
      ['dart', '2026-10-10', 'sent'],
    ])
  })

  it('발송에 실패한 날짜는 기록하지 않는다 — 기록하면 재기동이 그 날짜를 건너뛴다', async () => {
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn(async () => failed)
    const recordDigest = vi.fn<EventStore['recordDigest']>(async () => {})
    await catchUpDigests(deps(digestFor, send, undefined, recordDigest), '2026-10-10', '2026-10-11', null)

    expect(recordDigest).not.toHaveBeenCalled()
  })

  it('포기한 날짜는 abandoned 로 기록한다 — 안 남기면 재기동마다 그 날짜를 다시 붙잡는다', async () => {
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn(async () => failed)
    const recordDigest = vi.fn<EventStore['recordDigest']>(async () => {})
    const d = deps(digestFor, send, undefined, recordDigest)

    let attempt: DigestAttempt | null = null
    for (let i = 0; i < MAX_DIGEST_ATTEMPTS; i += 1) {
      attempt = (await catchUpDigests(d, '2026-10-10', '2026-10-11', attempt)).digestAttempt
    }

    expect(recordDigest.mock.calls).toEqual([['dart', '2026-10-10', 'abandoned']])
  })

  it('기록이 실패해도 던지지 않고 전진한다 — 같은 날짜를 다시 보내지 않는다', async () => {
    // 던지면 사이클이 실패해 lastDigestDate 가 전진하지 않고, 다음 사이클이 이미
    // 나간 다이제스트를 또 보낸다. 기록 실패(마이그레이션 미적용 등)가 이어지는
    // 동안 매 사이클 중복 발송이 된다 — 고치려던 것보다 나쁘다.
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn(async () => ({ ok: true }) as const)
    const recordDigest = vi.fn<EventStore['recordDigest']>(async () => {
      throw new Error('relation "digest_log" does not exist')
    })
    const log = { error: vi.fn() }

    const next = await catchUpDigests(deps(digestFor, send, log, recordDigest), '2026-10-09', '2026-10-11', null)

    expect(next.lastDigestDate).toBe('2026-10-11')
    expect(send).toHaveBeenCalledTimes(2)
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-10-09' }), 'digest log write failed',
    )
  })
})

describe('restoreLastDigestDate — 재기동 시 따라잡기 시작점', () => {
  function store(lastDigest: () => Promise<string | null>, lastEvent: string | null) {
    return {
      lastDigestKstDate: vi.fn(lastDigest),
      lastEventKstDate: vi.fn(async () => lastEvent),
    }
  }

  it('2026-10-11 회귀 — 이벤트 없는 날 뒤에 재기동해도 이미 보낸 날짜를 다시 보내지 않는다', async () => {
    // 마지막 공시는 10-08 이지만 다이제스트는 10-10 치까지 나갔다.
    const s = store(async () => '2026-10-10', '2026-10-08')
    const restored = await restoreLastDigestDate(s, 'dart', '2026-10-11', { error: vi.fn() })
    expect(restored).toBe('2026-10-11')

    // 복원값으로 따라잡기를 돌리면 아무것도 나가지 않는다.
    const digestFor = vi.fn<EventStore['digestFor']>(async () => emptyAgg)
    const send = vi.fn(async () => ({ ok: true }) as const)
    await catchUpDigests(deps(digestFor, send), restored, '2026-10-11', null)
    expect(send).not.toHaveBeenCalled()
  })

  it('워커가 며칠 죽어 있었으면 마지막 기록 다음 날부터 따라잡는다', async () => {
    const s = store(async () => '2026-09-30', '2026-10-01')
    expect(await restoreLastDigestDate(s, 'dart', '2026-10-04', { error: vi.fn() })).toBe('2026-10-01')
  })

  it('조회는 주어진 소스로 한다', async () => {
    const s = store(async () => '2026-10-10', null)
    await restoreLastDigestDate(s, 'dart', '2026-10-11', { error: vi.fn() })
    expect(s.lastDigestKstDate).toHaveBeenCalledWith('dart')
  })

  it('기록이 없으면(테이블이 생긴 직후) 마지막 이벤트 날짜로 물러선다', async () => {
    const s = store(async () => null, '2026-10-10')
    expect(await restoreLastDigestDate(s, 'dart', '2026-10-11', { error: vi.fn() })).toBe('2026-10-10')
  })

  it('기록도 이벤트도 없으면 오늘에서 시작한다', async () => {
    const s = store(async () => null, null)
    expect(await restoreLastDigestDate(s, 'dart', '2026-10-11', { error: vi.fn() })).toBe('2026-10-11')
  })

  it('기록을 읽지 못하면(마이그레이션 미적용) 기동을 막지 않고 마지막 이벤트 날짜로 물러선다', async () => {
    const s = store(async () => { throw new Error('relation "digest_log" does not exist') }, '2026-10-10')
    const log = { error: vi.fn() }
    expect(await restoreLastDigestDate(s, 'dart', '2026-10-11', log)).toBe('2026-10-10')
    expect(log.error).toHaveBeenCalledTimes(1)
  })
})
