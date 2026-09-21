import {
  bigint, bigserial, date, index, integer, jsonb, pgTable,
  primaryKey, text, timestamp, unique,
} from 'drizzle-orm/pg-core'

export const events = pgTable('events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sourceId: text('source_id').notNull(),
  externalId: text('external_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
  title: text('title').notNull(),
  url: text('url').notNull(),
  corpName: text('corp_name'),
  ticker: text('ticker'),
  market: text('market'),
  verdict: text('verdict').notNull(),
  tier: text('tier'),
  rule: text('rule').notNull(),
  raw: jsonb('raw').notNull(),
}, (t) => ({
  uq: unique('events_source_external_uq').on(t.sourceId, t.externalId),
  // 다이제스트의 5개 집계 쿼리가 전부 first_seen_at 범위로 하루를 자르고,
  // lastEventKstDate 가 기동마다 이 컬럼의 최대값을 찾는다.
  firstSeenIdx: index('events_first_seen_at_idx').on(t.firstSeenAt),
}))

export const outbox = pgTable('outbox', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  eventId: bigint('event_id', { mode: 'number' }).notNull().references(() => events.id),
  tier: text('tier').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastError: text('last_error'),
}, (t) => ({
  // claimPending 은 매 사이클 실행되고 where(status='pending' AND next_attempt_at <= now)
  // 로 좁힌다. 인덱스가 없으면 outbox 전체를 순차 스캔하며, sent/dead 가 쌓일수록
  // 그 비용이 단조 증가한다 — 매 폴링 사이클에 그대로 얹힌다.
  pendingIdx: index('outbox_status_next_attempt_idx').on(t.status, t.nextAttemptAt),
  // event_id 에는 외래키(ON DELETE no action)만 있고 인덱스가 없었다. events 에서
  // 행을 지울 때마다 Postgres 의 참조 무결성 트리거가 이 컬럼으로 outbox 를 훑어
  // 참조가 남았는지 확인하는데, 인덱스가 없으면 이 훑기가 순차 스캔이라 이벤트
  // 삭제 건수 × outbox 행 수만큼(O(n·m))의 비용이 pruneOlderThan 트랜잭션 하나
  // 안에서 발생한다 — 락을 오래 쥔 채로. digestFor 의 innerJoin 3개도 이 컬럼을
  // 조인 키로 쓰므로 같이 덕을 본다.
  eventIdx: index('outbox_event_id_idx').on(t.eventId),
}))

export const apiUsage = pgTable('api_usage', {
  usageDate: date('usage_date').notNull(),
  sourceId: text('source_id').notNull(),
  callCount: integer('call_count').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.usageDate, t.sourceId] }),
}))
