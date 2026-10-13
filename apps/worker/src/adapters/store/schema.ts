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

/**
 * 끝낸 다이제스트의 날짜. 재기동 시 따라잡기 시작점을 여기서 복원한다.
 *
 * 전에는 마지막 이벤트 날짜(events.first_seen_at)에서 복원했는데, 그 값은 "다이제스트를
 * 어디까지 보냈는가"가 아니라 "마지막으로 무언가를 수집한 날"이다. 공시가 없는
 * 날(주말·공휴일) 뒤에 재기동하면 이미 보낸 날짜들을 다시 보냈다 — 2026-10-11
 * 재기동에서 10-08~10-10 다이제스트 3건이 중복 발송됐다.
 *
 * 성공한 다이제스트는 워커 로그에 남지 않으므로, 서버 쪽에서 "어제 다이제스트가
 * 나갔는가"에 답할 수 있는 유일한 기록이기도 하다.
 */
export const digestLog = pgTable('digest_log', {
  sourceId: text('source_id').notNull(),
  kstDate: date('kst_date').notNull(),
  /** 'sent' | 'abandoned'. 포기한 날짜도 남겨야 재기동이 그 날짜를 다시 붙잡지 않는다. */
  outcome: text('outcome').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // source_id 가 앞이다 — 기동 시 조회가 `source_id = ? ORDER BY kst_date DESC LIMIT 1` 이다.
  pk: primaryKey({ columns: [t.sourceId, t.kstDate] }),
}))
