import { budgetGuard, kstDateString } from '../core/budget.js'
import { ALERT_THRESHOLD, createCircuit } from '../core/circuit.js'
import type { Circuit } from '../core/circuit.js'
import { pollIntervalMs } from '../core/schedule.js'
import { createSeenSet } from '../core/seen.js'
import type { SeenSet } from '../core/seen.js'
import type { EventStore } from '../ports/store.js'
import type { Notifier } from '../ports/notifier.js'
import type { Summarizer } from '../ports/summarizer.js'
import type { Heartbeat } from './health.js'
import { runIngest } from './ingest.js'
import type { IngestStats, SourcePlan } from './ingest.js'
import { runDispatch } from './dispatch.js'
import { catchUpDigests } from './digest.js'
import type { DigestAttempt } from './digest.js'

/**
 * main.ts 는 `main().catch(...)` 를 모듈 로드 시점에 바로 실행하므로 테스트에서
 * import 할 수 없다 — 그래서 한 사이클의 로직을 여기로 옮겨 직접 테스트할 수 있게
 * 한다. 동작은 main.ts 에 인라인으로 있던 것과 동일하다.
 */
export type CycleLogger = {
  info(obj: Record<string, unknown> | string, msg?: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

export type CycleDeps = {
  /**
   * 볼 소스들과 각각을 다루는 방법. 소스마다 폴링 주기·예산·판정이 다르므로
   * 하나로 묶어 받는다 (ingest.ts 의 SourcePlan).
   */
  plans: readonly SourcePlan[]
  store: EventStore
  /** 구독자용 채널. 공시 알림만 나간다. */
  notifier: Notifier
  /**
   * 운영자용 채널. 다이제스트와 연속 실패 알림이 나간다.
   * TELEGRAM_OPERATOR_CHAT_ID 가 없으면 main.ts 가 notifier 와 같은 것을 넣는다.
   *
   * 나누지 않으면 "⚠️ 워커 연속 실패 N회" 와 버려진 공시 목록·내부 카운터가
   * 공개 채널로 그대로 방송된다 — 공개 전환 당일에 터진다.
   */
  operatorNotifier: Notifier
  summarizer: Summarizer
  heartbeat: Heartbeat
  /**
   * 사이클 자체의 서킷. 수집 **바깥**(발송·다이제스트)에서 터진 실패와 전면
   * 수집 실패의 백오프를 담당한다. 소스별 건강 상태는 소스마다 따로 가진
   * 서킷이 본다 (CycleState.circuits).
   */
  circuit: Circuit
  log: CycleLogger
  /** 계정에 발급된 일일 한도. budgetGuard 와 다이제스트 분모에 그대로 흘러간다. */
  dailyLimit: number
}

export type CycleState = {
  lastDigestDate: string
  /** lastDigestDate 에 막혀 있는 날짜의 연속 실패 횟수. digest.ts 의 catchUpDigests 참고. */
  digestAttempt: DigestAttempt | null
  heartbeatFailures: number
  /**
   * 소스마다 따로 둔다 — externalId 는 소스 안에서만 유일하다. 공시 접수번호와
   * 뉴스 guid 가 우연히 겹치면 한 집합에서는 한쪽이 다른 쪽에 가려 안 보인다.
   */
  seen: Map<string, SeenSet>
  /** 소스마다 따로 둔다 — 새로 붙인 소스만 콜드 스타트일 수 있다. */
  coldStart: Map<string, boolean>
  /** 소스별 다음 실행 시각(ms). 주기가 서로 다르다. */
  nextRunAt: Map<string, number>
  /**
   * 소스별 서킷 브레이커. 하나를 공유하면 건강한 소스의 성공이 아픈 소스의
   * 연속 실패 카운터를 매 사이클 0 으로 되돌려, DART 가 완전히 죽어도 임계값에
   * 닿지 못하고 운영자 알림이 영영 0건 간다. 백오프도 같은 이유로 소스별이다.
   */
  circuits: Map<string, Circuit>
}

export type CycleResult = CycleState & { sleepMs: number }

/**
 * 다음 사이클까지 잘 시간. **성공하든 실패하든 규칙은 하나다** — 소스별
 * nextRunAt 중 가장 이른 것에 맞춘다.
 *
 * 예산 감속도 실패 백오프도 이미 각 소스의 nextRunAt 에 들어가 있다. 여기에
 * 사이클 단위 배수를 다시 곱하면 실패한 소스는 두 번 밀리고, 멀쩡한 소스는
 * 남의 장애 때문에 폴링이 멎는다 — DART 만 주기가 된 사이클에서 DART 가
 * 실패하면 사이클 전체가 10분을 자고, 자기 주기가 60초인 뉴스가 그 10분 동안
 * 한 번도 돌지 않았다(실측: 98분에 33회, 정상이면 98회).
 *
 * 소스가 하나뿐이면 이 값은 `plan.intervalMs(now) * 그 소스의 배수` 이므로
 * 기존 실패 경로의 `pollIntervalMs(now) * multiplier` 와 같은 수다.
 *
 * 1초 하한은 주기가 0 이하로 잡힌 소스가 루프를 바쁘게 돌리는 것을 막는다.
 * 소스가 하나도 없으면 Math.min() 이 Infinity 라 영원히 잠든다 — 폴백을 둔다.
 */
function sleepUntilSoonest(nextRunAt: ReadonlyMap<string, number>, now: Date): number {
  const deltas = [...nextRunAt.values()].map((t) => t - now.getTime())
  const soonest = deltas.length > 0 ? Math.min(...deltas) : pollIntervalMs(now)
  return Math.max(soonest, 1_000)
}

export async function runCycle(
  deps: CycleDeps, state: CycleState, now: Date,
): Promise<CycleResult> {
  const kstDate = kstDateString(now)
  let lastDigestDate = state.lastDigestDate
  let digestAttempt = state.digestAttempt
  let heartbeatFailures = state.heartbeatFailures
  // 실패 시에는 진입 상태 그대로 돌려준다 — 특히 coldStart 가 true 로 남아야
  // 기동 직후 DART 가 불통이었던 경우에도 첫 성공 사이클이 억제 사이클이 된다.
  // 소스별로 나뉘었으므로 수집에 성공한 소스만 각자 내려간다 — 한 소스의 장애가
  // 다른 소스의 억제 사이클을 소모하지 않는다.
  const seen = new Map(state.seen)
  const coldStart = new Map(state.coldStart)
  const nextRunAt = new Map(state.nextRunAt)
  const circuits = new Map(state.circuits)
  let sleepMs: number
  // 수집 전체가 실패해 던졌는가. 바깥 catch 가 알림을 한 번 더 보내지 않도록
  // 구분한다 — 소스별 알림이 이미 나갔다.
  let allSourcesFailed = false

  try {
    // 이번 사이클에 실제로 폴링한 소스 수와 그중 실패한 수. 주기 미달로
    // 건너뛴 소스는 어느 쪽에도 세지 않는다 — 보지 않은 소스는 성공도 실패도 아니다.
    let ranCount = 0
    let failedCount = 0
    // 첫 실패 원인. 바깥 catch 의 'cycle failed' 로그가 래퍼 에러만 남기면
    // 근본 원인이 그 줄에서 사라지므로 cause 로 달아 보낸다.
    let firstError: unknown = null
    const ingested: Array<{
      sourceId: string; stats: IngestStats; wasColdStart: boolean; seenSize: number
      /** 이 소스의 오늘 누적 호출 수. 한도를 추적하지 않는 소스는 null. */
      used: number | null
    }> = []

    for (const plan of deps.plans) {
      const id = plan.source.id
      if ((nextRunAt.get(id) ?? 0) > now.getTime()) continue
      const baseIntervalMs = plan.intervalMs(now)
      nextRunAt.set(id, now.getTime() + baseIntervalMs)
      ranCount += 1

      // 처음 보는 소스의 서킷은 여기서 만든다. 소스마다 따로 두는 이유는
      // CycleState.circuits 주석 참고.
      let circuit = circuits.get(id)
      if (circuit === undefined) {
        circuit = createCircuit()
        circuits.set(id, circuit)
      }

      let sourceUsed: number | null = null
      try {
        // 한도가 있는 소스만 센다. RSS 를 세면 DART 예산 가드가 엉뚱하게 발동해
        // 폴링 주기가 2~10배로 늘어진다.
        if (plan.countsAgainstApiBudget) {
          sourceUsed = await deps.store.incrementApiUsage(id, kstDate)
          // 예산 가드는 **이 소스 자신의 주기**에 건다. 사이클 전체 sleepMs 에만
          // 걸면 주기가 더 짧은 비예산 소스가 먼저 깨우는 순간 DART 가 원래
          // 주기로 다시 떠서 가드가 사실상 무력화된다 — 한도 초과로 020 을 맞아
          // 서비스가 통째로 멈추는 것이 최악의 실패다(core/budget.ts 주석).
          nextRunAt.set(
            id, now.getTime() + budgetGuard(sourceUsed, baseIntervalMs, deps.dailyLimit),
          )
        }
        // 처음 보는 소스는 콜드 스타트로 친다 — 새로 붙인 소스도 첫 사이클은
        // 기록만 하고 한 건도 발송하지 않아야 한다.
        const wasColdStart = coldStart.get(id) ?? true
        const ingest = await runIngest(
          { plan, store: deps.store },
          { seen: seen.get(id) ?? createSeenSet(), coldStart: wasColdStart },
          now,
        )
        seen.set(id, ingest.state.seen)
        coldStart.set(id, ingest.state.coldStart)
        // 자기 서킷만 되돌린다. 남의 카운터를 건드리면 아픈 소스의 장애가
        // 건강한 소스의 성공에 덮여 사라진다.
        circuit.recordSuccess()
        ingested.push({
          sourceId: id,
          stats: ingest.stats,
          wasColdStart,
          seenSize: ingest.state.seen.size,
          used: sourceUsed,
        })
      } catch (err) {
        // 한 소스의 장애가 다른 소스의 수집을 막으면 안 된다.
        // 다른 소스가 성공해 사이클 전체는 성공으로 끝나더라도 이 줄은 반드시
        // 남긴다. 조용한 부분 실패는 아무도 모르는 사이 한 소스의 수집이
        // 통째로 멎는 방식이다.
        deps.log.error({ err, sourceId: id }, 'source ingest failed')
        failedCount += 1
        if (firstError === null) firstError = err

        circuit.recordFailure()
        const failures = circuit.consecutiveFailures()

        // 백오프도 소스별이다. 아픈 소스의 다음 실행만 뒤로 민다 — 사이클 전체
        // sleepMs 를 늘리면 DART 장애가 멀쩡한 뉴스 폴링까지 몇 분씩 멈춰 세우고,
        // DART 자신도 10초가 아니라 그 몇 분 뒤에야 재시도된다.
        nextRunAt.set(id, now.getTime() + baseIntervalMs * circuit.intervalMultiplier())

        // `=== ALERT_THRESHOLD` 로 두면 안 된다: 전면 장애(DART·텔레그램 동시 불통) 시
        // 5회째의 단 한 번뿐인 발송이 조용히 실패하고 failures 는 6,7,8... 로 올라가
        // 다시 5가 되지 않으므로 장애 전 구간에 알림이 0건 간다.
        if (failures >= ALERT_THRESHOLD && failures % ALERT_THRESHOLD === 0) {
          // 어느 소스가 죽었는지 이름을 붙인다. 소스가 둘 이상이면 "워커가
          // 실패 중"이라는 말만으로는 운영자가 무엇을 봐야 할지 알 수 없다.
          await deps.operatorNotifier.send(
            `⚠️ [${id}] 워커 연속 실패 ${failures}회` +
            (heartbeatFailures > 0 ? `\n⚠️ heartbeat 미확인 ${heartbeatFailures}회 — 감시망 점검 필요` : ''),
          ).catch(() => {})
        }
      }
    }

    // **이번에 폴링한 소스가 전부 실패했을 때만** 사이클 실패로 던진다.
    //
    // 하나라도 살아 있으면 던지면 안 된다 — 던지는 순간 아래 runDispatch 를
    // 건너뛰어 **이미 outbox 에 들어가 발송을 기다리던 공시 알림까지 밀리고**,
    // 서킷 브레이커가 폴링 주기를 최대 32배로 늘리며 연속 실패 알림이 운영자를
    // 호출한다. 뉴스 피드 하나가 죽었다는 이유로 공시 알림을 멈추고 사람을
    // 부르는 것은 명백히 과잉이다.
    //
    // 그렇다고 전부 삼켜서도 안 된다. 전면 장애(DART·DB 동시 불통)에도 서킷
    // 브레이커가 돌지 않으면 연속 실패 알림이 0건 가고, 워커는 백오프 없이
    // 죽은 API 를 계속 두드린다. 던지는 위치도 그대로여야 한다 — 수집이 전부
    // 실패한 사이클에서 발송·다이제스트를 건너뛰는 기존 동작이다.
    //
    // 소스가 하나뿐인 현재 운영 구성에서는 "하나 실패 = 전부 실패"라 동작이
    // 이전과 완전히 같다. ranCount 가 0 인 사이클(전부 주기 미달)은 실패가
    // 아니다 — 아무것도 보지 않았을 뿐이다.
    if (ranCount > 0 && failedCount === ranCount) {
      allSourcesFailed = true
      throw new Error('all polled sources failed', { cause: firstError })
    }

    const dispatch = await runDispatch(
      { store: deps.store, notifier: deps.notifier, summarizer: deps.summarizer }, now,
    )

    deps.circuit.recordSuccess()

    for (const r of ingested) {
      // 억제는 반드시 로그에 남긴다. 운영자는 실시간 대응을 하지 않으므로, 재기동 후
      // "왜 그때 알림이 한 건도 안 왔는가"에 답할 기록이 여기밖에 없다.
      if (r.wasColdStart) {
        deps.log.info(
          {
            sourceId: r.sourceId,
            fetched: r.stats.fetched,
            suppressed: r.stats.suppressed,
            recorded: r.stats.recorded,
            seen: r.seenSize,
          },
          'cold start — backlog recorded, nothing enqueued',
        )
      }

      if (r.stats.recorded > 0 || dispatch.sent > 0) {
        deps.log.info({ sourceId: r.sourceId, ingest: r.stats, dispatch, used: r.used }, 'cycle')
      }
    }

    // 자정이 지나면 밀린 날짜를 하루씩 모두 보낸다. `= kstDate` 로 건너뛰면
    // 장애가 자정을 두 번 넘겼을 때 중간 날의 다이제스트가 영영 사라진다 —
    // 다이제스트는 운영자의 유일한 사후 감사 기록이므로 누락되면 안 된다.
    const caughtUp = await catchUpDigests(
      {
        store: deps.store,
        notifier: deps.operatorNotifier,
        // 공시 다이제스트는 기존 그대로 DART 사용량을 분모로 쓴다. 뉴스
        // 다이제스트는 3c 에서 따로 붙인다.
        sourceId: 'dart',
        log: deps.log,
        dailyLimit: deps.dailyLimit,
      },
      lastDigestDate,
      kstDate,
      digestAttempt,
    )
    lastDigestDate = caughtUp.lastDigestDate
    digestAttempt = caughtUp.digestAttempt

    sleepMs = sleepUntilSoonest(nextRunAt, now)
  } catch (err) {
    deps.circuit.recordFailure()
    const failures = deps.circuit.consecutiveFailures()
    deps.log.error({ err, failures }, 'cycle failed')

    // 수집 실패는 소스별 알림이 이미 담당했다. 여기서 또 보내면 전면 장애 때
    // 같은 사이클에 두 번 울린다 — 이 알림은 수집 바깥(발송·다이제스트)에서
    // 터진 실패만 맡는다.
    if (!allSourcesFailed) {
      // `=== ALERT_THRESHOLD` 로 두면 안 된다: 전면 장애(DART·텔레그램 동시 불통) 시
      // 5회째의 단 한 번뿐인 발송이 조용히 실패하고 failures 는 6,7,8... 로 올라가
      // 다시 5가 되지 않으므로 장애 전 구간에 알림이 0건 간다.
      if (failures >= ALERT_THRESHOLD && failures % ALERT_THRESHOLD === 0) {
        await deps.operatorNotifier.send(
          `⚠️ 워커 연속 실패 ${failures}회` +
          (heartbeatFailures > 0 ? `\n⚠️ heartbeat 미확인 ${heartbeatFailures}회 — 감시망 점검 필요` : ''),
        ).catch(() => {})
      }
    }

    // 실패 경로도 같은 규칙이다. 실패한 소스는 이미 자기 배수만큼 nextRunAt 이
    // 밀려 있고, 수집 바깥(발송·다이제스트)에서 터진 실패라면 소스들의
    // nextRunAt 은 이번 사이클 몫으로 정상 설정돼 있다. 사이클 단위 배수를
    // 여기서 다시 얹으면 멀쩡한 소스까지 같이 멈춘다.
    sleepMs = sleepUntilSoonest(nextRunAt, now)
  } finally {
    // heartbeat 은 반드시 finally 에 둔다. "프로세스가 살아 루프를 돌고 있는가"에
    // 답하는 신호이고, 그 답은 DART 성공 여부와 무관하기 때문이다.
    // try 안에 두면 DART 장애 중 워커가 멀쩡히 백오프하는 동안에도 핑이 끊겨
    // 외부 감시가 "VM 사망"으로 오판하고, 사람이 고칠 수 없고 저절로 낫는 일로
    // 운영자를 호출하게 된다. DART 실패는 서킷 브레이커 알림이 담당한다.
    // ping() 은 절대 throw 하지 않으므로 finally 에서 안전하다.
    heartbeatFailures = (await deps.heartbeat.ping()) ? 0 : heartbeatFailures + 1
  }

  return {
    sleepMs,
    lastDigestDate,
    digestAttempt,
    heartbeatFailures,
    seen,
    coldStart,
    nextRunAt,
    circuits,
  }
}

export type Sleeper = {
  sleep(ms: number): Promise<void>
  wakeNow(): void
}

/**
 * 중단 가능한 sleep. 종료 신호가 오면 즉시 깨운다.
 * 평범한 setTimeout 이면 주말 sleep(최대 5분)이나 서킷 백오프(최대 80초) 중에
 * SIGTERM 이 와도 그게 끝나야 루프 조건을 다시 보는데, Docker 기본 유예는 10초라
 * 그전에 SIGKILL 이 떨어진다 — 핸들러가 있으나 마나가 된다.
 */
export function createSleeper(): Sleeper {
  let wake: (() => void) | null = null
  return {
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(() => { wake = null; resolve() }, ms)
        wake = () => { clearTimeout(t); wake = null; resolve() }
      }),
    wakeNow: () => wake?.(),
  }
}

export type LoopControl = { shouldStop(): boolean }

/**
 * main.ts 는 모듈 로드 시점에 바로 실행되므로 이 while 루프 자체도 여기로
 * 옮겨 테스트 가능하게 한다. 동작은 main.ts 에 인라인으로 있던 것과 동일하다:
 * 사이클을 돌리고, 반환된 sleepMs 만큼 중단 가능한 sleep 을 하고, shouldStop()
 * 이 참이 되면(SIGTERM/SIGINT) 대기 중이던 sleep 이 즉시 풀리며 다음 사이클
 * 없이 빠져나간다.
 */
export async function runLoop(
  deps: CycleDeps, initialState: CycleState, sleeper: Sleeper, control: LoopControl,
): Promise<CycleState> {
  let state = initialState
  while (!control.shouldStop()) {
    const { sleepMs, ...next } = await runCycle(deps, state, new Date())
    state = next
    await sleeper.sleep(sleepMs)
  }
  return state
}
