import type { NormalizedEvent, Tier, Verdict } from '@app/shared'

export type PendingOutbox = {
  id: number
  eventId: number
  tier: Tier
  event: NormalizedEvent
  attempts: number
  expiresAt: Date
}

export type EventStore = {
  /**
   * 이벤트를 기록하고, pass면 같은 트랜잭션에서 outbox도 예약한다.
   * 이미 존재하는 externalId면 아무것도 하지 않고 false를 반환한다.
   */
  recordEvent(
    event: NormalizedEvent,
    verdict: Verdict,
    opts: { enqueue: boolean; expiresAt: Date | null },
  ): Promise<boolean>

  /**
   * 이 소스에서 가장 최근 기록된 externalId 를 최대 `limit` 개,
   * **오래된 것부터** 정렬해 반환한다. 행이 없으면 빈 배열.
   *
   * 재기동 시 seen-set 을 이 값으로 심는다. 심지 않으면 매 사이클 목록 API가
   * 돌려주는 최신 100건 전부가 recordEvent 로 가고(건당 트랜잭션 1개), 재기동마다
   * 100회의 무의미한 DB 왕복을 치르며 사이클이 그만큼 늘어진다.
   *
   * 정렬 방향이 중요하다 — seen-set 은 삽입 순서를 나이로 쓰고 가장 오래된 것부터
   * 축출하므로, 최신순으로 넣으면 가장 최근 id 가 먼저 버려진다.
   */
  recentExternalIds(sourceId: string, limit: number): Promise<string[]>

  /**
   * 가장 최근 events.first_seen_at 의 KST 날짜(YYYY-MM-DD). 행이 없으면 null.
   *
   * lastDigestDate 를 메모리에만 두면 KST 자정을 넘긴 재기동이 그 값을 오늘로
   * 되돌려 전날 다이제스트가 영영 발송되지 않는다 — 따라잡기 루프가 통째로
   * 무력화된다.
   */
  lastEventKstDate(): Promise<string | null>

  claimPending(now: Date, limit: number): Promise<PendingOutbox[]>
  markSent(outboxId: number): Promise<void>
  /**
   * 실패를 기록한다. `attempts` 는 **호출자가 결정한 최종값**이며 스토어는 시키는 대로 쓴다.
   * 스토어가 스스로 +1 하면 스로틀링(local-rate-limit)까지 예산을 잠식해,
   * 자가 조절만으로 정상 알림이 dead 가 된다.
   */
  markFailed(outboxId: number, error: string, nextAttemptAt: Date, attempts: number): Promise<void>
  markDead(outboxId: number, error: string): Promise<void>

  incrementApiUsage(sourceId: string, kstDate: string): Promise<number>
  getApiUsage(sourceId: string, kstDate: string): Promise<number>

  /** 일일 다이제스트용 집계. kstDate는 YYYY-MM-DD. */
  digestFor(kstDate: string): Promise<{
    sent: { critical: number; high: number; normal: number }
    dead: number
    missedCandidates: Array<{ title: string; corpName: string | null; ticker: string | null }>
    /** outbox.lastError 집계. 측정하지 않으면서 "에러 없음"을 표시하면 거짓 안심이 된다. */
    errorCounts: Record<string, number>
    /** 잘리지 않은 미매칭 총계. missedCandidates 는 상위 N건만 담으므로 이 값과 다를 수 있다. */
    missedTotal: number
  }>

  /**
   * `cutoff` 보다 오래된 events 와, 그에 딸린 **종결된**(sent/dead) outbox 행을 지운다.
   *
   * pending 은 아무리 오래돼도 지우지 않는다 — 미발송 건을 지우면 알림이 조용히
   * 사라지고, 그 사실을 알 방법도 남지 않는다. 만료된 pending 은 dispatch 가
   * expiresAt 으로 이미 정리한다.
   *
   * outbox 를 먼저 지운다. events.id 를 참조하는 외래키(ON DELETE no action)가 있어
   * 순서가 바뀌면 제약 위반으로 트랜잭션이 통째로 실패한다.
   *
   * 같은 이유로, pending 행이 하나라도 남아 참조하는 이벤트는 아무리 오래됐어도
   * 이번 호출에서 지우지 않는다 — 그 이벤트까지 지우면 같은 외래키 위반으로
   * 트랜잭션 전체가 롤백돼 보관 정책이 매번 조용히 실패한다. 그 pending 이
   * 나중에 sent/dead 로 종결되면 다음 호출에서 이벤트까지 함께 지워진다.
   */
  pruneOlderThan(cutoff: Date): Promise<{ events: number; outbox: number }>
}
