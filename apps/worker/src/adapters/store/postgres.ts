import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, notExists, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { NormalizedEvent, Tier } from '@app/shared'
import type { EventStore, PendingOutbox } from '../../ports/store.js'
import { kstDateString } from '../../core/budget.js'
import { apiUsage, events, outbox } from './schema.js'

export type Db = PostgresJsDatabase<Record<string, never>>

const VALID_TIERS: readonly Tier[] = ['critical', 'high', 'normal']

function isTier(value: string): value is Tier {
  return (VALID_TIERS as readonly string[]).includes(value)
}

/**
 * jsonb 컬럼은 Date 타입이 없어 왕복하면 occurredAt/firstSeenAt이 ISO 문자열로 저장된다.
 * NormalizedEvent는 이 둘을 Date로 못박아 두므로, 반환 직전에 되살린다.
 */
type StoredEventPayload = Omit<NormalizedEvent, 'occurredAt' | 'firstSeenAt'> & {
  occurredAt: string | null
  firstSeenAt: string
}

function rehydrateEvent(payload: unknown): NormalizedEvent {
  const raw = payload as StoredEventPayload
  return {
    ...raw,
    occurredAt: raw.occurredAt ? new Date(raw.occurredAt) : null,
    firstSeenAt: new Date(raw.firstSeenAt),
  }
}

export function createPostgresStore(db: Db): EventStore {
  // claimPending 에서도 불러야 해서 객체 리터럴 밖으로 끌어냈다.
  async function markDead(id: number, error: string): Promise<void> {
    await db.update(outbox).set({ status: 'dead', lastError: error }).where(eq(outbox.id, id))
  }

  return {
    async recordEvent(event, verdict, opts) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .insert(events)
          .values({
            sourceId: event.sourceId,
            externalId: event.externalId,
            occurredAt: event.occurredAt,
            firstSeenAt: event.firstSeenAt,
            title: event.title,
            url: event.url,
            corpName: event.subject?.name ?? null,
            ticker: event.subject?.ticker ?? null,
            market: event.subject?.market ?? null,
            verdict: verdict.action,
            tier: verdict.action === 'pass' ? verdict.tier : null,
            rule: verdict.action === 'pass' ? verdict.rule : verdict.reason,
            raw: event.raw,
          })
          .onConflictDoNothing()
          .returning({ id: events.id })

        const inserted = rows[0]
        if (!inserted) return false // 중복 — outbox를 건드리지 않는다

        if (opts.enqueue && verdict.action === 'pass' && opts.expiresAt) {
          await tx
            .insert(outbox)
            .values({
              eventId: inserted.id,
              tier: verdict.tier,
              payload: event as unknown as Record<string, unknown>,
              status: 'pending',
              attempts: 0,
              nextAttemptAt: event.firstSeenAt,
              expiresAt: opts.expiresAt,
            })
            .returning({ id: outbox.id })
        }
        return true
      })
    },

    async recentExternalIds(sourceId, limit) {
      // id(bigserial) 내림차순 = 워커가 가장 최근에 기록한 순서. external_id 순으로
      // 잡으면 안 된다 — 접수 순서와 공개 순서가 달라 뒤늦게 공개된 공시가 최근에
      // 기록됐는데도 번호가 낮아 빠진다. 기동 시 1회만 호출된다.
      const rows = await db
        .select({ externalId: events.externalId })
        .from(events)
        .where(eq(events.sourceId, sourceId))
        .orderBy(desc(events.id))
        .limit(limit)
      // seen-set 은 삽입 순서를 나이로 쓰므로 오래된 것부터 넣어야 한다.
      return rows.map((r) => r.externalId).reverse()
    },

    async lastEventKstDate() {
      // 메모리에만 있는 lastDigestDate 는 KST 자정을 넘긴 재기동이 오늘로 되돌려
      // 전날 다이제스트를 영영 없앤다 — 다이제스트는 운영자의 유일한 사후 감사
      // 기록이므로(스펙 §7.4) 기동 시 DB 에서 되살린다.
      const rows = await db
        .select({ firstSeenAt: events.firstSeenAt })
        .from(events)
        .orderBy(desc(events.firstSeenAt))
        .limit(1)
      const latest = rows[0]?.firstSeenAt
      return latest ? kstDateString(latest) : null
    },

    async claimPending(now, limit) {
      const rows = await db
        .select()
        .from(outbox)
        .where(and(eq(outbox.status, 'pending'), lte(outbox.nextAttemptAt, now)))
        // critical을 항상 먼저 고려한다 — outbox가 nextAttemptAt 기준으로만 정렬되면
        // limit 경계에서 critical(TTL 5분)이 non-critical 뒤로 밀려 claim되기 전에
        // 만료될 수 있다. Task 13이 배치 "안"에서 tier를 나누는 것과는 별개로,
        // 배치 "경계"에서부터 critical을 우선해야 한다.
        .orderBy(
          sql`CASE WHEN ${outbox.tier} = 'critical' THEN 0 ELSE 1 END`,
          asc(outbox.nextAttemptAt),
        )
        .limit(limit)

      const pending: PendingOutbox[] = []
      for (const r of rows) {
        if (!isTier(r.tier)) {
          // DB에는 CHECK 제약이 없어 손상되거나 예상치 못한 tier 값이 들어올 수 있다.
          // 이 한 행 때문에 전체 디스패치 루프를 멈추지 않도록 건너뛰고, 원인 추적을 위해 크게 로그를 남긴다.
          console.error(
            `[postgres-store] claimPending: outbox row ${r.id} has invalid tier "${r.tier}" — dead-lettering`,
          )
          // 건너뛰기만 하면 이 행은 pending 으로 영원히 남는다. 정렬 기준상
          // (critical 아님 → nextAttemptAt 오름차순) 가장 오래된 축이라 매 사이클
          // LIMIT 20 클레임 창의 앞자리를 다시 차지한다 — 이런 행이 20개면 정상
          // 알림은 단 한 건도 클레임되지 못하고 TTL 로 전부 만료된다.
          await markDead(r.id, 'invalid-tier')
          continue
        }
        pending.push({
          id: r.id,
          eventId: r.eventId,
          tier: r.tier,
          event: rehydrateEvent(r.payload),
          attempts: r.attempts,
          expiresAt: r.expiresAt,
        })
      }
      return pending
    },

    async markSent(id) {
      await db.update(outbox).set({ status: 'sent' }).where(eq(outbox.id, id))
    },

    async markFailed(id, error, nextAttemptAt, attempts) {
      await db
        .update(outbox)
        .set({ attempts, lastError: error, nextAttemptAt })
        .where(eq(outbox.id, id))
    },

    markDead,

    async incrementApiUsage(sourceId, kstDate) {
      const rows = await db
        .insert(apiUsage)
        .values({ usageDate: kstDate, sourceId, callCount: 1 })
        .onConflictDoUpdate({
          target: [apiUsage.usageDate, apiUsage.sourceId],
          set: { callCount: sql`${apiUsage.callCount} + 1` },
        })
        .returning({ callCount: apiUsage.callCount })
      return rows[0]?.callCount ?? 0
    },

    async getApiUsage(sourceId, kstDate) {
      const rows = await db
        .select({ c: apiUsage.callCount })
        .from(apiUsage)
        .where(and(eq(apiUsage.usageDate, kstDate), eq(apiUsage.sourceId, sourceId)))
      return rows[0]?.c ?? 0
    },

    async digestFor(kstDate, sourceId) {
      const dayStart = new Date(`${kstDate}T00:00:00+09:00`)
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000)

      // 다섯 집계 전부에 같은 조건으로 건다. sourceId 를 API 사용량 분모에만
      // 쓰면, 뉴스를 켜는 날 공시 다이제스트의 발송·dead·에러 카운트에 뉴스가
      // 섞이고, 50줄짜리 "룰 튜닝 후보" 목록이 종목만 잡히고 키워드가 안 잡힌
      // 뉴스로 뒤덮인다 — 그 목록이 다이제스트의 존재 이유 전부다.
      // 뉴스 다이제스트는 3c 로 미뤄져 있다(계획서). 쿼리 층에서도 지킨다.
      const ofSource = eq(events.sourceId, sourceId)

      const sentRows = await db.select({ tier: outbox.tier, n: sql<number>`count(*)::int` })
        .from(outbox)
        .innerJoin(events, eq(outbox.eventId, events.id))
        .where(and(
          eq(outbox.status, 'sent'),
          ofSource,
          gte(events.firstSeenAt, dayStart),
          lt(events.firstSeenAt, dayEnd),
        ))
        .groupBy(outbox.tier)

      const sent = { critical: 0, high: 0, normal: 0 }
      for (const r of sentRows) {
        if (r.tier === 'critical' || r.tier === 'high' || r.tier === 'normal') sent[r.tier] = r.n
      }

      const deadRows = await db.select({ n: sql<number>`count(*)::int` })
        .from(outbox)
        .innerJoin(events, eq(outbox.eventId, events.id))
        .where(and(
          eq(outbox.status, 'dead'),
          ofSource,
          gte(events.firstSeenAt, dayStart),
          lt(events.firstSeenAt, dayEnd),
        ))

      const missed = await db.select({
        title: events.title, corpName: events.corpName, ticker: events.ticker,
      }).from(events).where(and(
        eq(events.verdict, 'drop'),
        eq(events.rule, 'no-keyword-match'),
        ofSource,
        gte(events.firstSeenAt, dayStart),
        lt(events.firstSeenAt, dayEnd),
      )).limit(50)

      // outbox.lastError는 자유 텍스트이지만 재시도/dead 경로 모두 같은 문자열(예: 'dart-timeout')을
      // 남기므로 그룹핑이 유효하다. Top 5만 — 나머지 전부를 나열하면 다이제스트가 읽히지 않아
      // (읽히지 않는 다이제스트는 없는 것과 같다) 신호가 오히려 묻힌다.
      const errorRows = await db.select({
        err: outbox.lastError, n: sql<number>`count(*)::int`,
      }).from(outbox)
        .innerJoin(events, eq(outbox.eventId, events.id))
        .where(and(
          isNotNull(outbox.lastError),
          ofSource,
          gte(events.firstSeenAt, dayStart),
          lt(events.firstSeenAt, dayEnd),
        ))
        .groupBy(outbox.lastError)
        .orderBy(desc(sql`count(*)`))
        .limit(5)

      const errorCounts: Record<string, number> = {}
      for (const r of errorRows) if (r.err) errorCounts[r.err] = r.n

      // 잘리지 않은 총계를 따로 센다 — 50건 상한에 걸린 날 "50건"으로 보이면
      // 심각도가 과소 표시되고, 운영자는 문제가 작다고 오판한다.
      const missedTotalRows = await db.select({ n: sql<number>`count(*)::int` })
        .from(events).where(and(
          eq(events.verdict, 'drop'),
          eq(events.rule, 'no-keyword-match'),
          ofSource,
          gte(events.firstSeenAt, dayStart),
          lt(events.firstSeenAt, dayEnd),
        ))

      return {
        sent,
        dead: deadRows[0]?.n ?? 0,
        missedCandidates: missed,
        errorCounts,
        missedTotal: missedTotalRows[0]?.n ?? 0,
      }
    },

    async pruneOlderThan(cutoff) {
      // outbox 를 먼저 지운다 — outbox.event_id 가 events.id 를 참조하는 외래키라,
      // events 를 먼저 지우면 제약 위반으로 트랜잭션이 통째로 롤백되어 보관 정책이
      // 조용히 아무 일도 하지 않게 된다.
      return db.transaction(async (tx) => {
        // .returning() 을 쓰지 않는다 — 한 번도 정리된 적 없는 DB라면 대상이 수십만
        // 건일 수 있고, 그 id 전부를 배열로 힙에 올리면(두 테이블 모두, 한 트랜잭션
        // 안에서 동시에) 256MB 컨테이너에서 OOM 으로 트랜잭션이 죽는다 — 그러면 다음
        // 실행도 똑같이 죽는다. 대신 postgres.js 가 돌려주는 결과의 count 를 읽는다.
        // drizzle-orm 은 returning 필드를 지정하지 않으면 이 결과를 매핑하지 않고
        // 그대로 돌려준다(postgres-js/session.js: `!fields && !customResultMapper`
        // 분기) — postgres.js 의 Result 는 빈 배열이지만 count 프로퍼티에 영향받은
        // 행 수가 그대로 들어 있다.
        const ob = await tx
          .delete(outbox)
          .where(
            and(
              // pending 은 절대 포함하지 않는다 — 미발송 건을 지우면 알림이 조용히
              // 사라지고, 그 사실을 알 방법도 남지 않는다. 만료된 pending 은 dispatch 가
              // expiresAt 으로 이미 정리한다.
              inArray(outbox.status, ['sent', 'dead']),
              inArray(
                outbox.eventId,
                tx.select({ id: events.id }).from(events).where(lt(events.firstSeenAt, cutoff)),
              ),
            ),
          )

        const ev = await tx
          .delete(events)
          .where(
            and(
              lt(events.firstSeenAt, cutoff),
              // outbox.event_id 는 events.id 를 참조하는 외래키이고 ON DELETE no action
              // 이다 — 위에서 sent/dead 는 이미 지웠지만, pending 행이 하나라도 남아
              // 이 이벤트를 참조하면 이 DELETE 가 제약 위반으로 실패해 트랜잭션 전체가
              // 롤백된다. 그러면 보관 정책이 매일 똑같이 실패하며 조용히 아무 일도
              // 하지 않는다 — 이 기능이 막으려는 바로 그 무한 증식이 재발한다.
              // NOT EXISTS 로 참조가 하나도 안 남은 이벤트만 지운다. NOT IN 도 같은
              // 결과지만 서브쿼리가 NULL 을 반환하면 전체가 조용히 아무것도 안 지우는
              // 함정이 있다 — outbox.event_id 는 notNull 이라 여기선 해당 없지만,
              // NOT EXISTS 가 더 안전한 관용구이고 보통 플래너도 더 잘 처리한다.
              notExists(
                tx.select({ id: outbox.id }).from(outbox).where(eq(outbox.eventId, events.id)),
              ),
            ),
          )

        // "지운 게 0건"과 "지울 대상이 없어서 0건"은 운영자에게 전혀 다른 의미다.
        // 여기서 남은 이벤트는 정의상 cutoff 보다 오래됐는데 위 NOT EXISTS 에 걸려
        // 살아남은 행뿐이다(방금 그 DELETE 가 지울 수 있는 건 이미 다 지웠으므로).
        // COUNT(*) 라 전체 id를 힙에 올리지 않는다 — .returning() 을 뺀 이유와 같다.
        const pinnedRows = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(events)
          .where(lt(events.firstSeenAt, cutoff))

        return { events: ev.count, outbox: ob.count, pinned: pinnedRows[0]?.n ?? 0 }
      })
    },
  }
}
