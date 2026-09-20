import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { NormalizedEvent, Verdict } from '@app/shared'
import { kstDateString } from '../core/budget.js'
import { createCircuit, ALERT_THRESHOLD } from '../core/circuit.js'
import type { Circuit } from '../core/circuit.js'
import { evaluateDart } from '../core/dart/rules.js'
import { pollIntervalMs } from '../core/schedule.js'
import { createSeenSet } from '../core/seen.js'
import type { EventSource } from '../ports/source.js'
import type { EventStore } from '../ports/store.js'
import type { Notifier } from '../ports/notifier.js'
import type { Summarizer } from '../ports/summarizer.js'
import type { Heartbeat } from './health.js'
import type { SourcePlan } from './ingest.js'
import {
  runCycle, runLoop, createSleeper,
  type CycleDeps, type CycleLogger, type CycleState, type Sleeper,
} from './cycle.js'

const NOW = new Date('2026-09-19T06:30:00Z')
const TODAY = kstDateString(NOW)

function silentLog(): CycleLogger {
  return { info: vi.fn(), error: vi.fn() }
}

/** 이미 한 사이클을 돈 정상 가동 상태. 콜드 스타트 억제는 ingest.test.ts 가 다룬다. */
function warmState(heartbeatFailures = 0): CycleState {
  return {
    lastDigestDate: TODAY,
    digestAttempt: null,
    heartbeatFailures,
    // seen·coldStart 는 소스별이다 — externalId 는 소스 안에서만 유일하다.
    seen: new Map([['dart', createSeenSet(['20260919000100'])]]),
    coldStart: new Map([['dart', false]]),
    nextRunAt: new Map(),
  }
}

function failingStore(): EventStore {
  return {
    incrementApiUsage: async () => {
      throw new Error('db unreachable')
    },
  } as unknown as EventStore
}

function healthyStore(): EventStore {
  return {
    incrementApiUsage: async () => 1,
    claimPending: async () => [],
  } as unknown as EventStore
}

const source: EventSource = { id: 'dart', fetchLatest: async () => [] }
/** 기존 단일 소스 테스트가 쓰던 공시 소스 그대로 — 주기·예산·판정이 운영과 같다. */
const dartPlan: SourcePlan = {
  source,
  evaluate: evaluateDart,
  intervalMs: pollIntervalMs,
  countsAgainstApiBudget: true,
}
const summarizer: Summarizer = { summarize: async () => null }

describe('runCycle — heartbeat 은 finally 에 있어야 한다 (회귀 테스트)', () => {
  it('사이클이 실패해도 heartbeat.ping 을 호출한다', async () => {
    // 이 테스트는 heartbeat 호출이 try 블록 성공 경로에만 있다면(fix round 1
    // 이전 상태로 되돌아가면) 실패한다 — store.incrementApiUsage 가 즉시 던지므로
    // try 안에서는 ping 에 도달할 방법이 없다. finally 에 있을 때만 통과한다.
    const ping = vi.fn(async () => true)
    const heartbeat: Heartbeat = { ping }
    const notifier: Notifier = { send: vi.fn(async () => ({ ok: true }) as const) }
    const log = silentLog()

    const result = await runCycle(
      {
        plans: [dartPlan], store: failingStore(), notifier, operatorNotifier: notifier, summarizer, heartbeat,
        circuit: createCircuit(), log, dailyLimit: 20_000,
      },
      warmState(),
      NOW,
    )

    expect(ping).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalled() // 실패 분기를 실제로 탔는지 확인
    expect(result.heartbeatFailures).toBe(0) // ping 은 성공했으므로 리셋된 채 유지
  })

  it('사이클이 성공해도 heartbeat.ping 을 호출한다', async () => {
    const ping = vi.fn(async () => true)
    const heartbeat: Heartbeat = { ping }
    const notifier: Notifier = { send: vi.fn(async () => ({ ok: true }) as const) }
    const log = silentLog()

    const result = await runCycle(
      {
        plans: [dartPlan], store: healthyStore(), notifier, operatorNotifier: notifier, summarizer, heartbeat,
        circuit: createCircuit(), log, dailyLimit: 20_000,
      },
      warmState(),
      NOW,
    )

    expect(ping).toHaveBeenCalledTimes(1)
    expect(result.heartbeatFailures).toBe(0)
  })

  it('사이클 실패 중 heartbeat 도 실패하면 heartbeatFailures 를 누적한다', async () => {
    const ping = vi.fn(async () => false)
    const heartbeat: Heartbeat = { ping }
    const notifier: Notifier = { send: vi.fn(async () => ({ ok: true }) as const) }
    const log = silentLog()

    const result = await runCycle(
      {
        plans: [dartPlan], store: failingStore(), notifier, operatorNotifier: notifier, summarizer, heartbeat,
        circuit: createCircuit(), log, dailyLimit: 20_000,
      },
      warmState(2),
      NOW,
    )

    expect(ping).toHaveBeenCalledTimes(1)
    expect(result.heartbeatFailures).toBe(3) // 2에서 이어서 누적, 리셋되지 않는다
  })
})

describe('createSleeper — SIGTERM 이 대기 중에 와도 즉시 깨어난다', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('wakeNow 를 호출하면 전체 대기시간을 기다리지 않고 즉시 resolve 된다', async () => {
    const sleeper = createSleeper()
    const promise = sleeper.sleep(60_000)
    let resolved = false
    void promise.then(() => { resolved = true })

    sleeper.wakeNow()
    await promise // resolve 는 wakeNow 안에서 동기적으로 트리거되므로 타이머를 진행시킬 필요가 없다

    expect(resolved).toBe(true)
  })

  it('wakeNow 는 남은 타이머를 정리해 흘리지 않는다', () => {
    const sleeper = createSleeper()
    void sleeper.sleep(60_000)
    expect(vi.getTimerCount()).toBe(1)

    sleeper.wakeNow()
    expect(vi.getTimerCount()).toBe(0) // clearTimeout 이 실제로 호출되었는지 확인
  })

  it('wakeNow 없이 시간이 다 지나면 정상적으로 resolve 된다', async () => {
    const sleeper = createSleeper()
    const promise = sleeper.sleep(1_000)
    vi.advanceTimersByTime(1_000)
    await expect(promise).resolves.toBeUndefined()
  })

  it('대기 중이 아닐 때 wakeNow 를 호출해도 안전하다 — 신호가 사이클 실행 중에 온 경우', () => {
    const sleeper = createSleeper()
    expect(() => sleeper.wakeNow()).not.toThrow()
  })
})

describe('runLoop — 종료 신호가 대기 중에 오면 다음 사이클 없이 빠져나간다', () => {
  it('sleep 도중 shouldStop 이 참이 되면 사이클을 한 번만 돌리고 끝난다', async () => {
    // shouldStop 재확인이 빠지면 이 테스트는 통과/실패로 끝나지 않고 무한히
    // 돈다 — digest 무한루프 회귀 테스트와 같은 이유로 짧은 타임아웃을 건다.
    const incrementApiUsage = vi.fn(async () => 1)
    const store = {
      incrementApiUsage,
      claimPending: async () => [],
    } as unknown as EventStore
    const ping = vi.fn(async () => true)
    const heartbeat: Heartbeat = { ping }
    const notifier: Notifier = { send: vi.fn(async () => ({ ok: true }) as const) }
    const log = silentLog()

    let shuttingDown = false
    // 실제 타이머 기반 sleeper 대신, "sleep 도중 신호가 온다"는 상황을 결정적으로
    // 재현하는 가짜 sleeper 를 준다 — 실제로는 wakeNow() 가 이 역할을 한다.
    const fakeSleeper: Sleeper = {
      sleep: async () => { shuttingDown = true },
      wakeNow: () => {},
    }

    await runLoop(
      {
        plans: [dartPlan], store, notifier, operatorNotifier: notifier, summarizer, heartbeat,
        circuit: createCircuit(), log, dailyLimit: 20_000,
      },
      warmState(),
      fakeSleeper,
      { shouldStop: () => shuttingDown },
    )

    // sleep 이 끝난 뒤 루프 상단에서 shouldStop() 을 다시 확인해 두 번째
    // 사이클을 시작하지 않아야 한다 — incrementApiUsage 는 사이클당 정확히 한 번 불린다.
    expect(incrementApiUsage).toHaveBeenCalledTimes(1)
  }, 2_000)

  it('shouldStop 이 처음부터 참이면 사이클을 한 번도 돌리지 않는다', async () => {
    const incrementApiUsage = vi.fn(async () => 1)
    const store = { incrementApiUsage, claimPending: async () => [] } as unknown as EventStore
    const heartbeat: Heartbeat = { ping: vi.fn(async () => true) }
    const notifier: Notifier = { send: vi.fn(async () => ({ ok: true }) as const) }
    const log = silentLog()

    await runLoop(
      {
        plans: [dartPlan], store, notifier, operatorNotifier: notifier, summarizer, heartbeat,
        circuit: createCircuit(), log, dailyLimit: 20_000,
      },
      warmState(),
      createSleeper(),
      { shouldStop: () => true },
    )

    expect(incrementApiUsage).not.toHaveBeenCalled()
  })
})

/**
 * I7 회귀 — 채널이 하나면 "⚠️ 워커 연속 실패 N회" 와 일일 다이제스트(버려진 공시
 * 목록·내부 카운터)가 구독자에게 그대로 방송된다. 공개 전환 당일에 터진다.
 */
describe('runCycle — 운영자 알림은 구독자 채널로 가지 않는다', () => {
  function notifierPair() {
    const subscriber: Notifier = { send: vi.fn(async () => ({ ok: true }) as const) }
    const operator: Notifier = { send: vi.fn(async () => ({ ok: true }) as const) }
    return { subscriber, operator }
  }

  it('연속 실패 알림은 operatorNotifier 로만 간다', async () => {
    const { subscriber, operator } = notifierPair()
    const circuit = createCircuit()
    const heartbeat: Heartbeat = { ping: vi.fn(async () => true) }
    const deps = {
      plans: [dartPlan], store: failingStore(), notifier: subscriber, operatorNotifier: operator,
      summarizer, heartbeat, circuit, log: silentLog(), dailyLimit: 20_000,
    }

    // ALERT_THRESHOLD(5) 회째에 알림이 나간다. 소스별 nextRunAt 이 생겼으므로
    // 매 사이클 시계를 폴링 주기만큼 밀어야 실제로 5회 폴링한다 — 같은 시각으로
    // 다섯 번 부르면 2회차부터 주기 미달로 건너뛰어 실패가 쌓이지 않는다.
    // 운영에서는 실패 후 sleep 이 최소 폴링 주기이므로 이 진행이 실제 동작과 같다.
    let state = warmState()
    for (let i = 0; i < ALERT_THRESHOLD; i += 1) {
      const at = new Date(NOW.getTime() + i * pollIntervalMs(NOW))
      const { sleepMs: _sleepMs, ...next } = await runCycle(deps, state, at)
      state = next
    }

    expect(operator.send).toHaveBeenCalledTimes(1)
    expect(vi.mocked(operator.send).mock.calls[0]?.[0]).toContain('워커 연속 실패')
    expect(subscriber.send).not.toHaveBeenCalled()
  })

  it('다이제스트는 operatorNotifier 로만 간다', async () => {
    const { subscriber, operator } = notifierPair()
    const store = {
      incrementApiUsage: async () => 1,
      claimPending: async () => [],
      digestFor: async () => ({
        sent: { critical: 0, high: 0, normal: 0 },
        dead: 0, missedCandidates: [], errorCounts: {}, missedTotal: 0,
      }),
      getApiUsage: async () => 0,
    } as unknown as EventStore
    const heartbeat: Heartbeat = { ping: vi.fn(async () => true) }

    // 어제 날짜를 들고 들어가면 이번 사이클에 어제치 다이제스트가 나간다.
    await runCycle(
      {
        plans: [dartPlan], store, notifier: subscriber, operatorNotifier: operator,
        summarizer, heartbeat, circuit: createCircuit(), log: silentLog(), dailyLimit: 20_000,
      },
      { ...warmState(), lastDigestDate: '2026-09-18' },
      NOW,
    )

    expect(operator.send).toHaveBeenCalledTimes(1)
    expect(vi.mocked(operator.send).mock.calls[0]?.[0]).toContain('리포트')
    expect(subscriber.send).not.toHaveBeenCalled()
  })
})

/**
 * 3a — 소스가 둘 이상이 된다. 주기(DART 10초 / RSS 30초~3분), 예산(DART 만 한도
 * 추적), 판정 함수가 소스마다 달라 SourcePlan 으로 묶어 넘긴다.
 */
describe('runCycle — 다중 소스', () => {
  /** 월요일 KST 10:00 — 장중이라 폴링 주기가 가장 짧은 구간이다. */
  const MULTI_NOW = new Date('2026-09-21T01:00:00Z')

  function fakePlan(id: string, intervalMs: number, countsAgainstApiBudget = true) {
    return {
      source: {
        id,
        fetchLatest: vi.fn(async (_now: Date): Promise<NormalizedEvent[]> => []),
      },
      evaluate: (): Verdict => ({ action: 'drop', reason: 'test' }),
      intervalMs: () => intervalMs,
      countsAgainstApiBudget,
    }
  }

  /**
   * 진짜 서킷을 감싼 스파이. 연속 실패 횟수 계산은 실제 구현 그대로 두고
   * 호출 여부만 본다 — 임의의 스텁으로 바꾸면 알림 임계값 동작이 달라진다.
   */
  function spyCircuit(): Circuit {
    const circuit = createCircuit()
    return {
      recordSuccess: vi.fn(circuit.recordSuccess),
      recordFailure: vi.fn(circuit.recordFailure),
      consecutiveFailures: () => circuit.consecutiveFailures(),
      intervalMultiplier: () => circuit.intervalMultiplier(),
    }
  }

  function depsWith(plans: readonly SourcePlan[]): CycleDeps {
    const store = {
      incrementApiUsage: vi.fn(async () => 1),
      // runDispatch 가 가장 먼저 부르는 것이라 "발송 단계까지 갔는가"의 신호가 된다.
      claimPending: vi.fn(async () => []),
    } as unknown as EventStore
    const notifier: Notifier = { send: vi.fn(async () => ({ ok: true }) as const) }
    return {
      plans,
      store,
      notifier,
      operatorNotifier: notifier,
      summarizer,
      heartbeat: { ping: vi.fn(async () => true) },
      circuit: spyCircuit(),
      log: silentLog(),
      dailyLimit: 20_000,
    }
  }

  function initialState(plans: readonly SourcePlan[]): CycleState {
    return {
      lastDigestDate: kstDateString(MULTI_NOW),
      digestAttempt: null,
      heartbeatFailures: 0,
      seen: new Map(plans.map((p) => [p.source.id, createSeenSet([])])),
      coldStart: new Map(plans.map((p) => [p.source.id, false])),
      nextRunAt: new Map(),
    }
  }

  it('주기가 아직 안 된 소스는 건너뛴다', async () => {
    const fast = fakePlan('dart', 10_000)
    const slow = fakePlan('news', 60_000)
    const deps = depsWith([fast, slow])
    let state = initialState([fast, slow])

    state = await runCycle(deps, state, new Date('2026-09-21T01:00:00Z'))
    expect(fast.source.fetchLatest).toHaveBeenCalledTimes(1)
    expect(slow.source.fetchLatest).toHaveBeenCalledTimes(1)

    // 10초 뒤 — 빠른 소스만 다시 본다
    state = await runCycle(deps, state, new Date('2026-09-21T01:00:10Z'))
    expect(fast.source.fetchLatest).toHaveBeenCalledTimes(2)
    expect(slow.source.fetchLatest).toHaveBeenCalledTimes(1)
  })

  it('api_usage는 예산이 있는 소스만 올린다', async () => {
    const dart = fakePlan('dart', 10_000, true)
    const news = fakePlan('news', 10_000, false)
    const deps = depsWith([dart, news])
    await runCycle(deps, initialState([dart, news]), new Date('2026-09-21T01:00:00Z'))
    expect(deps.store.incrementApiUsage).toHaveBeenCalledTimes(1)
    expect(deps.store.incrementApiUsage).toHaveBeenCalledWith('dart', expect.any(String))
  })

  it('한 소스가 던져도 다른 소스는 처리된다', async () => {
    const bad = fakePlan('dart', 10_000)
    bad.source.fetchLatest = vi.fn().mockRejectedValue(new Error('DART down'))
    const good = fakePlan('news', 10_000)
    const deps = depsWith([bad, good])
    await runCycle(deps, initialState([bad, good]), new Date('2026-09-21T01:00:00Z'))
    expect(good.source.fetchLatest).toHaveBeenCalledTimes(1)
  })

  it('seen-set은 소스마다 따로다 — externalId가 충돌할 수 있다', async () => {
    const a = fakePlan('dart', 10_000)
    const b = fakePlan('news', 10_000)
    const deps = depsWith([a, b])
    const state = await runCycle(deps, initialState([a, b]), new Date('2026-09-21T01:00:00Z'))
    expect(state.seen.get('dart')).not.toBe(state.seen.get('news'))
  })

  /**
   * 사이클 실패는 **폴링한 소스가 전부 실패했을 때**만이다. 뉴스 피드 하나가
   * 죽었다고 던지면 runDispatch 를 건너뛰어 이미 outbox 에서 대기 중이던 공시
   * 알림까지 밀리고, 서킷 브레이커가 폴링을 늘리며 운영자를 호출한다.
   */
  describe('부분 실패는 사이클 실패가 아니다', () => {
    it('한 소스만 실패하면 발송은 그대로 진행되고 성공으로 기록된다', async () => {
      const bad = fakePlan('news', 10_000)
      bad.source.fetchLatest = vi.fn().mockRejectedValue(new Error('RSS down'))
      const good = fakePlan('dart', 10_000)
      const deps = depsWith([good, bad])

      await runCycle(deps, initialState([good, bad]), MULTI_NOW)

      // 발송 단계까지 갔다 — outbox 의 공시 알림이 뉴스 장애에 묶이지 않는다.
      expect(deps.store.claimPending).toHaveBeenCalledTimes(1)
      expect(deps.circuit.recordSuccess).toHaveBeenCalledTimes(1)
      expect(deps.circuit.recordFailure).not.toHaveBeenCalled()
      // 부분 실패도 반드시 남는다 — 조용히 넘어가면 뉴스 수집이 멎은 줄 모른다.
      expect(deps.log.error).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: 'news' }),
        'source ingest failed',
      )
    })

    it('폴링한 소스가 전부 실패하면 사이클 실패다 — 발송도 건너뛴다', async () => {
      const a = fakePlan('dart', 10_000)
      a.source.fetchLatest = vi.fn().mockRejectedValue(new Error('DART down'))
      const b = fakePlan('news', 10_000)
      b.source.fetchLatest = vi.fn().mockRejectedValue(new Error('RSS down'))
      const deps = depsWith([a, b])

      await runCycle(deps, initialState([a, b]), MULTI_NOW)

      expect(deps.circuit.recordFailure).toHaveBeenCalledTimes(1)
      expect(deps.circuit.recordSuccess).not.toHaveBeenCalled()
      expect(deps.store.claimPending).not.toHaveBeenCalled()
      expect(deps.log.error).toHaveBeenCalledWith(
        expect.objectContaining({ failures: 1 }),
        'cycle failed',
      )
    })

    it('소스가 하나뿐이면 그 하나의 실패가 곧 전면 실패다 — 기존 동작 그대로', async () => {
      const only = fakePlan('dart', 10_000)
      only.source.fetchLatest = vi.fn().mockRejectedValue(new Error('DART down'))
      const deps = depsWith([only])

      await runCycle(deps, initialState([only]), MULTI_NOW)

      expect(deps.circuit.recordFailure).toHaveBeenCalledTimes(1)
      expect(deps.circuit.recordSuccess).not.toHaveBeenCalled()
      expect(deps.store.claimPending).not.toHaveBeenCalled()
    })

    it('주기 미달로 아무 소스도 안 본 사이클은 실패가 아니다', async () => {
      const a = fakePlan('dart', 10_000)
      const b = fakePlan('news', 60_000)
      const deps = depsWith([a, b])

      // 첫 사이클에서 둘 다 보고, 같은 시각에 한 번 더 돈다 — 둘 다 주기 미달이다.
      const state = await runCycle(deps, initialState([a, b]), MULTI_NOW)
      await runCycle(deps, state, MULTI_NOW)

      expect(a.source.fetchLatest).toHaveBeenCalledTimes(1)
      expect(b.source.fetchLatest).toHaveBeenCalledTimes(1)
      expect(deps.circuit.recordFailure).not.toHaveBeenCalled()
      expect(deps.circuit.recordSuccess).toHaveBeenCalledTimes(2)
    })
  })
})
