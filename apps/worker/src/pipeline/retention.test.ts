import { describe, it, expect, vi } from 'vitest'
import { runRetention } from './retention.js'

// pruneOlderThan 은 세 값을 돌려준다 — events/outbox 뿐 아니라 pinned 도 있다.
// pinned 는 브리프 작성 이후(Task 9 리뷰 라운드)에 추가됐다: cutoff 보다 오래됐지만
// pending outbox 가 아직 물고 있어 이번 호출에서 못 지운 이벤트 수다.
const deps = () => ({
  store: { pruneOlderThan: vi.fn().mockResolvedValue({ events: 10, outbox: 3, pinned: 2 }) },
  log: { info: vi.fn(), error: vi.fn() },
})

describe('runRetention', () => {
  it('날짜가 바뀌면 한 번 돈다', async () => {
    const d = deps()
    const next = await runRetention(d as never, '2026-09-19', new Date('2026-09-20T01:00:00Z'))
    expect(d.store.pruneOlderThan).toHaveBeenCalledTimes(1)
    expect(next).toBe('2026-09-20')
  })

  it('같은 날 두 번째 사이클에는 돌지 않는다', async () => {
    const d = deps()
    const next = await runRetention(d as never, '2026-09-20', new Date('2026-09-20T05:00:00Z'))
    expect(d.store.pruneOlderThan).not.toHaveBeenCalled()
    expect(next).toBe('2026-09-20')
  })

  it('세 카운트를 모두 로그에 남긴다 — pinned 가 빠지면 막힌 행이 조용히 묻힌다', async () => {
    const d = deps()
    await runRetention(d as never, '2026-09-19', new Date('2026-09-20T01:00:00Z'))
    expect(d.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ events: 10, outbox: 3, pinned: 2 }),
      'retention pruned',
    )
  })

  it('lastPruneDate 가 오늘보다 앞서 있어도(시계 스큐) 돌지 않는다', async () => {
    // NTP 보정 등으로 시계가 KST 자정 너머로 되돌아가면 today 가 lastPruneDate
    // 보다 과거가 될 수 있다. `===` 가드라면 이 경우 조건이 거짓이 되어 매
    // 사이클 전체 스윕이 반복된다 — digest.ts 의 catchUpDigests 와 같은 함정.
    const d = deps()
    // KST = UTC+9 이므로 UTC 2026-09-20T14:30 은 KST 2026-09-20T23:30 — 같은 UTC
    // 날짜라도 kstDateString 은 '2026-09-20' 을 돌려준다. lastPruneDate('2026-09-21')
    // 보다 하루 과거다.
    const next = await runRetention(d as never, '2026-09-21', new Date('2026-09-20T14:30:00Z'))
    expect(d.store.pruneOlderThan).not.toHaveBeenCalled()
    // 앞서 있던 날짜를 그대로 유지한다 — today 로 되돌리면(과거로) 다음 정상
    // 사이클에서 다시 그 날짜와 비교가 어긋날 수 있다.
    expect(next).toBe('2026-09-21')
  })

  it('삭제가 실패해도 던지지 않는다 — 정리 실패로 수집이 멈추면 안 된다', async () => {
    const d = deps()
    d.store.pruneOlderThan.mockRejectedValue(new Error('deadlock'))
    const next = await runRetention(d as never, '2026-09-19', new Date('2026-09-20T01:00:00Z'))
    expect(d.log.error).toHaveBeenCalled()
    // 날짜를 넘기지 않아 다음 사이클이 다시 시도한다
    expect(next).toBe('2026-09-19')
  })
})
