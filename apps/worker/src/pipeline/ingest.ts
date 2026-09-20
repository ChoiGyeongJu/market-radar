import type { NormalizedEvent, Verdict } from '@app/shared'
import { expiresAt } from '../core/policy.js'
import type { SeenSet } from '../core/seen.js'
import type { EventSource } from '../ports/source.js'
import type { EventStore } from '../ports/store.js'

/**
 * 하나의 소스와 그 소스를 다루는 방법을 묶는다. 소스마다 폴링 주기·예산·판정이
 * 다르므로 `EventSource` 만으로는 부족하다.
 */
export type SourcePlan = {
  source: EventSource
  /** 이 소스의 판정 함수. DART 는 evaluateDart, 뉴스는 evaluateNews 를 감싼 것. */
  evaluate: (event: NormalizedEvent) => Verdict
  /** 이 소스를 얼마나 자주 볼 것인가. 시각별로 달라질 수 있다. */
  intervalMs(now: Date): number
  /**
   * DART 처럼 일일 호출 한도가 있는 소스만 true. RSS 는 한도가 없으므로 false 이고,
   * api_usage 를 올리지 않는다 — 올리면 DART 예산 가드가 엉뚱하게 발동한다.
   */
  countsAgainstApiBudget: boolean
}

export type IngestDeps = { plan: SourcePlan; store: EventStore }

/**
 * 사이클을 넘어 살아남는 수집 상태. 이 두 값이 스펙 §6.4 의 "재기동 폭탄 방지"와
 * 재조회 억제를 함께 구현한다.
 *
 * `seen` — 이미 처리한 externalId 의 경계 있는 집합(core/seen.ts). 집합 안에 있으면
 *   DB 를 아예 건드리지 않고 건너뛴다.
 *
 *   이것이 없으면 `fetchLatest` 가 매 사이클 같은 최신 100건을 돌려주는데 그 100건
 *   전부가 `recordEvent` 로 가고, 건당 트랜잭션 1개다. 장중 10초 주기 기준 하루
 *   40만 건의 트랜잭션이 원격 Postgres 로 날아가고 그중 99%는 유니크 충돌로 아무것도
 *   하지 않는 no-op 이다. 100회의 직렬 왕복은 사이클의 상당 부분을 먹으므로 주기를
 *   다시 조이려 할 때 가장 먼저 걸리는 벽이기도 하다.
 *
 *   집합이라 **도착 순서를 전혀 가정하지 않는다.** 하이워터 마크(최대 id)였다면
 *   접수는 먼저 했지만 심사 때문에 늦게 공개된 공시가 영영 건너뛰어졌다 —
 *   기록조차 남지 않아 그런 공시가 있었다는 사실 자체를 알 수 없었다. 근거는
 *   core/seen.ts 주석 참고.
 *
 * `coldStart` — 아직 한 번도 수집에 성공하지 않았는가. 첫 성공 사이클에서만 참이다.
 */
export type IngestState = {
  seen: SeenSet
  coldStart: boolean
}

export type IngestStats = {
  fetched: number
  /** 이미 본 id 라 DB를 건드리지 않고 건너뛴 건수. 정상 상태에선 대부분이 여기 잡힌다. */
  skipped: number
  recorded: number
  enqueued: number
  /** pass 판정이지만 콜드 스타트라 발송 예약을 하지 않은 건수. */
  suppressed: number
  duplicated: number
}

export type IngestResult = { stats: IngestStats; state: IngestState }

export async function runIngest(
  deps: IngestDeps, state: IngestState, now: Date,
): Promise<IngestResult> {
  const events = await deps.plan.source.fetchLatest(now)
  const stats: IngestStats = {
    fetched: events.length, skipped: 0, recorded: 0, enqueued: 0, suppressed: 0, duplicated: 0,
  }

  for (const event of events) {
    if (state.seen.has(event.externalId)) {
      stats.skipped += 1
      continue
    }

    const verdict: Verdict = deps.plan.evaluate(event)

    // 게이트 8 — 콜드 스타트 억제. 재기동 직후 워커는 **자신이 얼마나 오래 죽어
    // 있었는지 알 수 없다.** 처음 보는 것이 방금 들어온 1건인지 사흘치 밀린
    // 물량인지 구분할 방법이 없으므로, 첫 사이클은 전부 기록만 하고 한 건도
    // 발송하지 않는다. 두 번째 사이클부터 처음 보는 것은 워커가 살아서 지켜보는
    // 동안 새로 공개된 것이 확실하므로 정상 발송한다.
    //
    // verdict 자체는 건드리지 않는다. events.verdict/rule 은 필터가 내린 판정을
    // 담는 칼럼이고 골든셋·룰 튜닝(스펙 §7.4)이 그 값을 근거로 삼는다 — 워커의
    // 가동 시간을 필터 판정으로 덮어쓰면 그 데이터가 오염된다. 억제된 건은
    // "verdict=pass 인데 outbox 행이 없는 이벤트"로 사후 식별된다.
    const enqueue = verdict.action === 'pass' && !state.coldStart

    const inserted = await deps.store.recordEvent(event, verdict, {
      enqueue,
      expiresAt: verdict.action === 'pass' && enqueue ? expiresAt(verdict.tier, now) : null,
    })

    // recordEvent 가 성공한 뒤에 넣는다. 중복(inserted === false)도 DB 에 있다는
    // 뜻이므로 본 것으로 친다. 던졌다면 넣지 않아 다음 사이클이 다시 시도한다.
    state.seen.add(event.externalId)

    if (!inserted) { stats.duplicated += 1; continue }
    stats.recorded += 1
    if (enqueue) stats.enqueued += 1
    else if (verdict.action === 'pass') stats.suppressed += 1
  }

  // seen 은 가변이라 루프 도중 던져도 그때까지 기록에 성공한 id 는 남는다 —
  // 재시도 시 이미 쓴 것을 다시 쓰지 않는다. coldStart 는 루프가 끝까지 돌았을
  // 때만 내려간다.
  return { stats, state: { seen: state.seen, coldStart: false } }
}
