import { describe, it, expect, vi } from 'vitest'
import { Column, getTableName, is, Param, SQL, StringChunk } from 'drizzle-orm'
import type { NormalizedEvent } from '@app/shared'
import { createPostgresStore, type Db } from './postgres.js'
import { events, outbox } from './schema.js'

const event: NormalizedEvent = {
  sourceId: 'dart',
  externalId: '20260919000123',
  occurredAt: new Date('2026-09-18T15:00:00Z'),
  firstSeenAt: new Date('2026-09-19T06:30:00Z'),
  title: '무상증자결정',
  url: 'https://example.test',
  subject: { name: '샘플', ticker: '005930', market: 'Y' },
  raw: {},
}

/** 트랜잭션 호출을 기록하는 fake. */
function fakeDb(insertedEventId: number | null) {
  const calls: string[] = []
  const tx = {
    insert: (table: unknown) => {
      const name = getTableName(table as never)
      calls.push(name)
      return {
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => (insertedEventId === null ? [] : [{ id: insertedEventId }]),
          }),
          returning: async () => [{ id: 1 }],
        }),
      }
    },
  }
  const db = { transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) }
  return { db: db as unknown as Db, calls }
}

describe('recordEvent', () => {
  it('pass면 events와 outbox를 같은 트랜잭션에서 쓴다', async () => {
    const { db, calls } = fakeDb(42)
    const store = createPostgresStore(db)

    const inserted = await store.recordEvent(
      event,
      { action: 'pass', tier: 'critical', rule: 'keyword:무상증자결정' },
      { enqueue: true, expiresAt: new Date('2026-09-19T06:35:00Z') },
    )

    expect(inserted).toBe(true)
    expect(calls).toEqual(['events', 'outbox'])
  })

  it('중복이면 outbox를 쓰지 않고 false를 반환한다', async () => {
    const { db, calls } = fakeDb(null)
    const store = createPostgresStore(db)

    const inserted = await store.recordEvent(
      event,
      { action: 'pass', tier: 'critical', rule: 'keyword:무상증자결정' },
      { enqueue: true, expiresAt: new Date('2026-09-19T06:35:00Z') },
    )

    expect(inserted).toBe(false)
    expect(calls).toEqual(['events'])
  })

  it('drop이면 events만 쓴다 — 사유 추적을 위해 기록은 남긴다', async () => {
    const { db, calls } = fakeDb(43)
    const store = createPostgresStore(db)

    const inserted = await store.recordEvent(
      event,
      { action: 'drop', reason: 'no-keyword-match' },
      { enqueue: false, expiresAt: null },
    )

    expect(inserted).toBe(true)
    expect(calls).toEqual(['events'])
  })
})

/**
 * select().from().where().orderBy().limit() 체인을 흉내내는 fake.
 *
 * orderBy에 전달된 인자를 그대로 기록해 반환한다 — 이 fake는 실제 정렬을
 * 수행하지 않으므로(그럴 수도 없다: 정렬은 Postgres가 한다), rows의 순서를
 * 검증하는 테스트는 정렬 로직이 있든 없든 통과해 아무것도 증명하지 못한다.
 * 대신 orderBy로 전달된 SQL 조각 자체를 검증해야 한다.
 */
function fakeSelectDb(rows: unknown[]) {
  const orderByCalls: unknown[][] = []
  // claimPending 이 잘못된 tier 행을 dead-letter 처리하므로 update 경로도 필요하다.
  const updates: { id: unknown; values: unknown }[] = []
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: (...args: unknown[]) => {
            orderByCalls.push(args)
            return { limit: async () => rows }
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: unknown) => ({
        where: async (cond: unknown) => {
          updates.push({ id: collectParamValues(cond)[0], values })
        },
      }),
    }),
  }
  return { db: db as unknown as Db, orderByCalls, updates }
}

/** SQL 조각의 StringChunk들을 이어붙여 리터럴 텍스트를 복원한다. */
function sqlText(fragment: SQL): string {
  return fragment.queryChunks
    .filter((c): c is StringChunk => c instanceof StringChunk)
    .map((c) => c.value.join(''))
    .join('')
}

/** update().set().where() 체인을 흉내내는 fake. set()에 전달된 값을 그대로 기록한다. */
function fakeUpdateDb() {
  const calls: { table: string; values: unknown }[] = []
  const db = {
    update: (table: unknown) => ({
      set: (values: unknown) => {
        calls.push({ table: getTableName(table as never), values })
        return { where: async () => {} }
      },
    }),
  }
  return { db: db as unknown as Db, calls }
}

describe('markFailed', () => {
  it(
    '전달받은 attempts 값을 그대로 쓴다 — 스스로 +1 하지 않는다. ' +
      'store가 스스로 증가시키면 local-rate-limit 스로틀링까지 시도 횟수를 소비해, ' +
      '자가 조절만으로 정상 알림이 dead 처리될 수 있다 (Task 13 회귀).',
    async () => {
      const { db, calls } = fakeUpdateDb()
      const store = createPostgresStore(db)

      await store.markFailed(7, 'boom', new Date('2026-09-19T06:35:00Z'), 3)

      expect(calls).toHaveLength(1)
      expect(calls[0]?.table).toBe('outbox')
      // 리터럴 3이어야 한다 — `sql\`attempts + 1\`` 같은 SQL 조각이면 안 된다.
      expect(calls[0]?.values).toEqual({
        attempts: 3,
        lastError: 'boom',
        nextAttemptAt: new Date('2026-09-19T06:35:00Z'),
      })
    },
  )
})

describe('claimPending', () => {
  it('유효한 tier 값을 가진 행을 PendingOutbox로 변환하고, jsonb 왕복으로 문자열이 된 firstSeenAt을 Date로 되살린다', async () => {
    const { db } = fakeSelectDb([
      {
        id: 1,
        eventId: 10,
        tier: 'critical',
        // 실제 Postgres에서는 jsonb 왕복 후 Date가 ISO 문자열로 온다.
        payload: { ...event, occurredAt: event.occurredAt?.toISOString() ?? null, firstSeenAt: event.firstSeenAt.toISOString() },
        attempts: 0,
        expiresAt: new Date('2026-09-19T06:35:00Z'),
      },
    ])
    const store = createPostgresStore(db)

    const rows = await store.claimPending(new Date('2026-09-19T06:31:00Z'), 10)

    expect(rows).toEqual([
      {
        id: 1,
        eventId: 10,
        tier: 'critical',
        event,
        attempts: 0,
        expiresAt: new Date('2026-09-19T06:35:00Z'),
      },
    ])
    expect(rows[0]?.event.firstSeenAt).toBeInstanceOf(Date)
    expect(rows[0]?.event.occurredAt).toBeInstanceOf(Date)
  })

  it(
    'tier 값이 유효하지 않은 행은 dead 처리하고, 나머지 행은 정상 반환한다 — ' +
      '건너뛰기만 하면 그 행이 pending 으로 영원히 남아 매 사이클 LIMIT 20 클레임 창의 ' +
      '앞자리를 다시 차지한다. 그런 행이 20개면 정상 알림은 한 건도 클레임되지 못하고 ' +
      'TTL 로 전부 만료된다 — 영구 기아 상태다.',
    async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db, updates } = fakeSelectDb([
      {
        id: 1,
        eventId: 10,
        tier: 'urgent', // Tier가 아닌 값 — 손상되었거나 예상치 못한 데이터
        payload: event,
        attempts: 0,
        expiresAt: new Date('2026-09-19T06:35:00Z'),
      },
      {
        id: 2,
        eventId: 11,
        tier: 'high',
        payload: event,
        attempts: 0,
        expiresAt: new Date('2026-09-19T06:35:00Z'),
      },
    ])
    const store = createPostgresStore(db)

    const rows = await store.claimPending(new Date('2026-09-19T06:31:00Z'), 10)

    expect(rows).toEqual([
      {
        id: 2,
        eventId: 11,
        tier: 'high',
        event,
        attempts: 0,
        expiresAt: new Date('2026-09-19T06:35:00Z'),
      },
    ])
    // 손상된 행은 pending 으로 남지 않는다.
    expect(updates).toEqual([
      { id: 1, values: { status: 'dead', lastError: 'invalid-tier' } },
    ])

    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
    },
  )

  it(
    'critical tier를 nextAttemptAt보다 먼저 정렬한다 — ' +
      'outbox 적체 시 TTL이 가장 짧은(5분) critical 알림이 배치 경계에서 밀려 만료되는 것을 막는다',
    async () => {
      const { db, orderByCalls } = fakeSelectDb([])
      const store = createPostgresStore(db)

      await store.claimPending(new Date('2026-09-19T06:31:00Z'), 10)

      // fakeSelectDb는 정렬을 실제로 수행하지 않는다 — rows 순서로는 이 로직을
      // 증명할 수 없다. orderBy에 실제로 전달된 SQL 조각을 검증한다.
      expect(orderByCalls).toHaveLength(1)
      const args = orderByCalls[0] ?? []
      expect(args).toHaveLength(2)
      const [tierOrder, timeOrder] = args as [SQL, SQL]

      // 1번째 기준: outbox.tier를 참조하는 CASE WHEN critical → 0, 그 외 → 1.
      // asc(nextAttemptAt) 하나만 남는 회귀가 생기면 orderBy가 인자 1개로
      // 호출되어 위 toHaveLength(2)에서 이미 실패하고, 컬럼이 바뀌면 아래에서 실패한다.
      expect(tierOrder).toBeInstanceOf(SQL)
      expect(tierOrder.queryChunks).toContain(outbox.tier)
      const tierText = sqlText(tierOrder)
      expect(tierText).toContain('CASE WHEN')
      expect(tierText).toContain('critical')
      expect(tierText).toContain('THEN 0 ELSE 1 END')

      // 2번째 기준: nextAttemptAt 오름차순 (critical 안에서도, non-critical 안에서도
      // 먼저 접수된 것부터 처리하기 위함).
      expect(timeOrder).toBeInstanceOf(SQL)
      expect(timeOrder.queryChunks).toContain(outbox.nextAttemptAt)
      expect(sqlText(timeOrder).toLowerCase()).toContain('asc')
    },
  )
})

/** SQL 조각 트리(중첩 SQL, 예: and()가 eq()/gte()/lt() 여럿을 감싼 것)를 재귀적으로
 * 순회하며 모든 Param 값을 모은다. `eq(col, 'drop')`의 'drop'은 StringChunk가 아니라
 * Param으로 표현되므로(파라미터 바인딩), 위의 sqlText()로는 보이지 않는다 — 이 헬퍼가 필요한 이유. */
function collectParamValues(node: unknown, out: unknown[] = []): unknown[] {
  if (is(node, Param)) {
    out.push(node.value)
    return out
  }
  // inArray(col, ['a','b'])는 sql`${col} in ${values.map(...)}` 로 만들어지는데,
  // 이 배열은 SQL로 감싸이지 않은 채 queryChunks에 그대로 박힌다(drizzle-orm
  // sql/sql.js의 buildQueryFromSourceParams가 Array.isArray(chunk)를 별도로
  // 처리하는 것과 같은 이유) — 이 분기가 없으면 inArray 안의 Param들이 전부 누락된다.
  if (Array.isArray(node)) {
    for (const item of node) collectParamValues(item, out)
    return out
  }
  if (node instanceof SQL) {
    for (const chunk of node.queryChunks) collectParamValues(chunk, out)
  }
  return out
}

/** SQL 조각 트리에서 실제로 참조된 Column들을 모은다 — inArray/eq/lt 가 어떤 컬럼을
 * 대상으로 하는지(예: outbox.status vs outbox.eventId) 확인하는 데 쓴다. */
function collectColumns(node: unknown, out: unknown[] = []): unknown[] {
  if (is(node, Column)) {
    out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) collectColumns(item, out)
    return out
  }
  if (node instanceof SQL) {
    for (const chunk of node.queryChunks) collectColumns(chunk, out)
  }
  return out
}

/**
 * SQL 조각 트리를 재귀적으로 순회하며 모든 StringChunk 텍스트를 모은다.
 *
 * drizzle-orm 0.45.2 소스(sql/expressions/conditions.js)를 직접 읽어 확인한 구조:
 * `and(c1, c2, ...)`(조건 2개 이상)는 `new SQL([StringChunk("("), sql.join(conds, StringChunk(" and ")), StringChunk(")")])`를
 * 반환하고, `or(...)`는 구분자만 `StringChunk(" or ")`로 다르다 — 조건들 자체(각각 eq/gte/lt가 만든 SQL)는
 * 동일하므로, 리프 값(Param)만 비교하면 and와 or를 구분하지 못한다. 이 함수로 얻은 텍스트에서
 * " and " / " or " 구분자 자체를 확인해야 조합자(combinator)를 고정할 수 있다.
 */
function collectStringChunkText(node: unknown, out: string[] = []): string[] {
  if (node instanceof StringChunk) {
    out.push(node.value.join(''))
    return out
  }
  if (node instanceof SQL) {
    for (const chunk of node.queryChunks) collectStringChunkText(chunk, out)
  }
  return out
}

type DigestChain = {
  from: () => DigestChain
  innerJoin: () => DigestChain
  where: (cond: unknown) => DigestChain
  groupBy: () => DigestChain
  orderBy: () => DigestChain
  limit: () => DigestChain
  then: (resolve: (v: unknown) => void) => void
}

/**
 * digestFor()가 순서대로 날리는 5개 select 쿼리(sent, dead, missed, errors, missedTotal)를
 * 흉내내는 fake. 체인 길이가 쿼리마다 달라(groupBy/orderBy/limit 유무) 모든 메서드를 no-op으로
 * 체이닝하고, where()에 전달된 조건만 호출 순서대로 기록한다. 5개 쿼리는 Promise.all 없이
 * 순차적으로 await되므로 — 실제 구현이 그렇게 짜여 있다 — 공유 카운터만으로 몇 번째
 * select()인지 안전하게 구분할 수 있다.
 */
function fakeDigestDb(rowsByCall: unknown[][]) {
  const whereCalls: unknown[] = []
  let call = -1
  const chain: DigestChain = {
    from: () => chain,
    innerJoin: () => chain,
    where: (cond) => {
      whereCalls[call] = cond
      return chain
    },
    groupBy: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve) => resolve(rowsByCall[call] ?? []),
  }
  const db = {
    select: () => {
      call += 1
      return chain
    },
  }
  return { db: db as unknown as Db, whereCalls }
}

describe('digestFor', () => {
  it(
    '미매칭 후보 조회는 verdict=drop AND rule=no-keyword-match 두 조건을 AND로 묶는다 — ' +
      '조건 하나가 빠지거나 AND가 OR로 바뀌면 전체 drop이 쏟아져 다이제스트가 읽히지 않거나(노이즈), ' +
      '아예 걸러져 신호가 사라진다(과다 제한). 순서: 0=sent, 1=dead, 2=missed, 3=errors, 4=missedTotal.',
    async () => {
      const { db, whereCalls } = fakeDigestDb([[], [], [], [], []])
      const store = createPostgresStore(db)

      await store.digestFor('2026-09-19')

      const missedWhere = whereCalls[2]

      // 리프 값: 두 조건의 값이 실제로 쿼리에 쓰였는가.
      const values = collectParamValues(missedWhere)
      expect(values).toContain('drop')
      expect(values).toContain('no-keyword-match')

      // 조합자: 값만 확인하면 and(...)를 or(...)로 바꿔도(여전히 두 값 다 등장) 통과해 버린다 —
      // or로 바뀌면 조건 하나만 맞아도 걸리므로 이 조회가 반환하는 행이 폭발한다.
      // " and " / " or " 구분자 리터럴 자체가 쿼리에 어떻게 쓰였는지 확인해야 잡을 수 있다.
      const text = collectStringChunkText(missedWhere).join('')
      expect(text).toContain(' and ')
      expect(text).not.toContain(' or ')
    },
  )

  it('outbox.lastError를 집계해 errorCounts로 반환한다 — null인 lastError는 제외한다', async () => {
    const { db } = fakeDigestDb([
      [], // sent
      [], // dead
      [], // missed
      [
        { err: 'dart-timeout', n: 3 },
        { err: 'telegram-429', n: 1 },
        { err: null, n: 7 }, // 실제로는 isNotNull()이 SQL 단에서 걸러내는 행 — 매핑 가드가 통과시키지 않는지 확인
      ],
      [], // missedTotal
    ])
    const store = createPostgresStore(db)

    const result = await store.digestFor('2026-09-19')

    expect(result.errorCounts).toEqual({ 'dart-timeout': 3, 'telegram-429': 1 })
  })

  it('미매칭 총계를 표시 목록과 별도로 잘리지 않게 센다 — 50건 상한에 걸려도 실제 건수를 알 수 있어야 한다', async () => {
    const { db } = fakeDigestDb([
      [], // sent
      [], // dead
      Array.from({ length: 50 }, () => ({ title: 't', corpName: 'c', ticker: null })), // missed (상한 도달)
      [], // errors
      [{ n: 300 }], // missedTotal — 상한과 무관한 진짜 총계
    ])
    const store = createPostgresStore(db)

    const result = await store.digestFor('2026-09-19')

    expect(result.missedCandidates).toHaveLength(50)
    expect(result.missedTotal).toBe(300)
  })
})

/**
 * select().from().where()[.orderBy().limit()] 를 흉내내되, 체인 자체가 thenable 이라
 * 어느 단계에서 await 해도 rows 가 나온다 — 쿼리마다 체인 길이가 다르기 때문이다.
 */
type SelectChain = {
  from: () => SelectChain
  where: (cond: unknown) => SelectChain
  orderBy: (...args: unknown[]) => SelectChain
  limit: () => SelectChain
  then: (resolve: (v: unknown) => void) => void
}

function fakeThenableDb(rows: unknown[]) {
  const whereCalls: unknown[] = []
  const orderByCalls: unknown[][] = []
  const chain: SelectChain = {
    from: () => chain,
    where: (cond) => { whereCalls.push(cond); return chain },
    orderBy: (...args) => { orderByCalls.push(args); return chain },
    limit: () => chain,
    then: (resolve) => resolve(rows),
  }
  const db = { select: () => chain }
  return { db: db as unknown as Db, whereCalls, orderByCalls }
}

describe('recentExternalIds — seen-set 의 기동 시 시드', () => {
  it('오래된 것부터 정렬해 반환한다 — 집합이 삽입 순서를 나이로 쓰기 때문이다', async () => {
    // 최신순으로 넣으면 가장 최근 id 가 먼저 축출되어, 방금 처리한 공시가 다음
    // 사이클에 다시 처리 대상이 된다.
    const { db } = fakeThenableDb([
      { externalId: 'c' }, { externalId: 'b' }, { externalId: 'a' }, // DB 는 id desc
    ])
    expect(await createPostgresStore(db).recentExternalIds('dart', 3))
      .toEqual(['a', 'b', 'c'])
  })

  it('source_id 로 좁힌다', async () => {
    const { db, whereCalls } = fakeThenableDb([])
    await createPostgresStore(db).recentExternalIds('dart', 500)

    // 좁히지 않으면 나중에 소스가 추가됐을 때(스펙 §3 의 2·3단계) 다른 소스의 id 가
    // 시드를 채워 DART 공시가 집합에 없는 채로 남는다.
    expect(collectParamValues(whereCalls[0])).toContain('dart')
  })

  it('행이 없으면 빈 배열 — 빈 DB 에서는 아무것도 건너뛰지 않는다', async () => {
    const { db } = fakeThenableDb([])
    expect(await createPostgresStore(db).recentExternalIds('dart', 500)).toEqual([])
  })

  it(
    'id 내림차순으로 조회한다 — external_id 순으로 잡으면 뒤늦게 공개된 공시가 ' +
      '최근에 기록됐는데도 번호가 낮아 시드에서 빠진다',
    async () => {
      const { db, orderByCalls } = fakeThenableDb([])
      await createPostgresStore(db).recentExternalIds('dart', 500)

      expect(orderByCalls).toHaveLength(1)
      const [order] = (orderByCalls[0] ?? []) as [SQL]
      expect(order.queryChunks).toContain(events.id)
      expect(sqlText(order).toLowerCase()).toContain('desc')
    },
  )
})

/**
 * I4 회귀 — lastDigestDate 가 메모리에만 있으면 KST 자정을 넘긴 재기동이 그 값을
 * 오늘로 되돌려 전날 다이제스트가 영영 발송되지 않는다. 따라잡기 루프가 통째로
 * 무력화되고, 다이제스트는 운영자의 유일한 사후 감사 기록이다(스펙 §7.4).
 */
describe('lastEventKstDate — 재기동 시 lastDigestDate 복원', () => {
  it('가장 최근 이벤트의 KST 날짜를 반환한다', async () => {
    const { db } = fakeThenableDb([{ firstSeenAt: new Date('2026-09-18T06:30:00Z') }])
    expect(await createPostgresStore(db).lastEventKstDate()).toBe('2026-09-18')
  })

  it('UTC 가 아니라 KST 기준으로 날짜를 계산한다', async () => {
    // 2026-09-18T15:00:00Z = 2026-09-19T00:00:00+09:00 — KST 로는 이미 19일이다.
    // UTC 로 잘라내면 18일이 나와 하루치 다이제스트가 어긋난다.
    const { db } = fakeThenableDb([{ firstSeenAt: new Date('2026-09-18T15:00:00Z') }])
    expect(await createPostgresStore(db).lastEventKstDate()).toBe('2026-09-19')
  })

  it('테이블이 비면 null 을 반환한다 — 호출자가 오늘 날짜로 시작한다', async () => {
    const { db } = fakeThenableDb([])
    expect(await createPostgresStore(db).lastEventKstDate()).toBeNull()
  })

  it('first_seen_at 내림차순 1건으로 조회한다 — 오름차순이면 가장 오래된 날이 나온다', async () => {
    const { db, orderByCalls } = fakeThenableDb([])
    await createPostgresStore(db).lastEventKstDate()

    expect(orderByCalls).toHaveLength(1)
    const [order] = (orderByCalls[0] ?? []) as [SQL]
    expect(order.queryChunks).toContain(events.firstSeenAt)
    expect(sqlText(order).toLowerCase()).toContain('desc')
  })
})

type EventRow = { id: number; firstSeenAt: Date }
type OutboxRow = { id: number; eventId: number; status: string }
type Bindings = { events?: EventRow; outbox?: OutboxRow }
type PruneTables = { events: EventRow[]; outbox: OutboxRow[] }

/**
 * fakeSelectChain 이 만드는 서브쿼리/쿼리 표현. `tx.select(...).from(...).where(...)` 는
 * 대개 실행되지 않고 inArray/notExists 의 인자로 그대로 전달되므로(실제 drizzle의
 * PgSelect도 await 되기 전까진 실행되지 않는다), evalSelect 가 나중에 평가할 수
 * 있도록 대상 테이블·조건·선택 컬럼만 들고 있으면 된다. getSQL() 은 isSQLWrapper
 * 계약 — 이게 없으면 inArray/notExists 가 이 객체를 Param 으로 잘못 감싸버린다.
 * then 은 선택적이다 — pinned 카운트처럼 이 select 자체가 직접 await 되는 경우에만
 * fakeSelectChain 이 채워 넣는다.
 */
type FakeSubquery = {
  __table: 'events' | 'outbox'
  __where: unknown
  __col: unknown
  getSQL: () => unknown
  then?: (resolve: (v: unknown[]) => void) => void
}

function isFakeSubquery(node: unknown): node is FakeSubquery {
  return typeof node === 'object' && node !== null && '__table' in node
}

function resolveScalar(node: unknown, b: Bindings): unknown {
  if (is(node, Param)) return node.value
  // 컬럼은 문자열 이름이 아니라 schema.ts 의 실제 객체 동일성으로 식별한다 —
  // 이름 매핑으로 하면 평가기 자신의 버그로 잘못된 컬럼을 착각해 연결해도
  // 타입 검사로 걸러지지 않는다.
  if (node === events.id) return b.events?.id
  if (node === events.firstSeenAt) return b.events?.firstSeenAt
  if (node === outbox.id) return b.outbox?.id
  if (node === outbox.eventId) return b.outbox?.eventId
  if (node === outbox.status) return b.outbox?.status
  throw new Error('fakeTxDb: 평가기가 모르는 컬럼이 조건에 쓰였다 — resolveScalar를 갱신해야 한다')
}

/**
 * eq/lt/inArray/notExists/and 가 만든 SQL 조각을 "노드 자신의" StringChunk 텍스트로
 * 구분한다. 자식 SQL 안의 StringChunk까지 내려가면 " = "와 " and " 같은 텍스트가
 * 뒤섞여 노드 종류를 구분할 수 없으므로, 이 노드의 queryChunks 배열 자체의 모양과
 * 그 안의 StringChunk만 본다 — drizzle-orm 0.45.2 sql/sql.js의 sql() 템플릿 함수가
 * 만드는 고정된 모양(이항 연산자는 5개 청크, and/notExists는 3개 청크)에 기대는
 * 것과 같은 방식을, 파일 상단의 sqlText()/collectStringChunkText()가 이미 쓰고 있다.
 */
function classify(node: SQL): 'and' | 'eq' | 'lt' | 'inArray' | 'notExists' {
  const chunks = node.queryChunks
  if (chunks.length === 3 && chunks[0] instanceof StringChunk) {
    const head = chunks[0].value.join('')
    if (head === '(') return 'and'
    if (head.startsWith('not exists')) return 'notExists'
  }
  if (chunks.length === 5 && chunks[2] instanceof StringChunk) {
    const op = chunks[2].value.join('')
    if (op === ' = ') return 'eq'
    if (op === ' < ') return 'lt'
    if (op === ' in ') return 'inArray'
  }
  throw new Error('fakeTxDb: 평가기가 모르는 조건 형태 — classify를 갱신해야 한다')
}

function evalCond(node: unknown, b: Bindings, tables: PruneTables): boolean {
  if (!(node instanceof SQL)) throw new Error('fakeTxDb: SQL 조건이 아니다')
  const chunks = node.queryChunks
  switch (classify(node)) {
    case 'and': {
      const joined = chunks[1]
      if (!(joined instanceof SQL)) throw new Error('fakeTxDb: and 구조가 예상과 다르다')
      const children = joined.queryChunks.filter((c): c is SQL => c instanceof SQL)
      if (children.length < 2) throw new Error('fakeTxDb: and 자식이 2개 미만이다')
      return children.every((c) => evalCond(c, b, tables))
    }
    case 'eq':
      return resolveScalar(chunks[1], b) === resolveScalar(chunks[3], b)
    case 'lt': {
      const left = resolveScalar(chunks[1], b) as Date
      const right = resolveScalar(chunks[3], b) as Date
      return left.getTime() < right.getTime()
    }
    case 'inArray': {
      const left = resolveScalar(chunks[1], b)
      const right = chunks[3]
      if (Array.isArray(right)) {
        return right.map((p) => (is(p, Param) ? p.value : p)).includes(left)
      }
      return evalSelect(right, b, tables).includes(left)
    }
    case 'notExists':
      return evalSelect(chunks[1], b, tables).length === 0
  }
}

function evalSelect(node: unknown, outer: Bindings, tables: PruneTables): unknown[] {
  if (!isFakeSubquery(node)) throw new Error('fakeTxDb: 서브쿼리 형태가 아니다')
  const out: unknown[] = []
  for (const row of tables[node.__table]) {
    const b: Bindings = { ...outer, [node.__table]: row } as Bindings
    if (evalCond(node.__where, b, tables)) out.push(resolveScalar(node.__col, b))
  }
  return out
}

/**
 * `tx.select(cols).from(table).where(cond)` 를 흉내낸다. 두 가지 방식으로 쓰인다:
 *
 * 1. inArray/notExists 의 서브쿼리 인자로 — 절대 await 되지 않고 getSQL() 계약만
 *    요구된다(실제 drizzle의 PgSelect도 마찬가지).
 * 2. pinned 카운트처럼 직접 await 되는 최상위 쿼리로 — 이 fake 안에서는 count(*)
 *    집계 하나뿐이므로, then()이 호출되면 __where 에 매칭되는 행 수를 세어
 *    `[{ <cols의 키>: n }]` 형태로 resolve 한다. 같은 객체가 getSQL() 도 갖고
 *    있어서 두 용도 모두를 하나의 반환값으로 처리한다 — 실제 코드가 이 select 를
 *    서브쿼리로 쓸지 직접 await 할지는 postgres.ts 쪽에서 결정하는 것이지 fake가
 *    미리 알 필요가 없다.
 */
function fakeSelectChain(cols: Record<string, unknown>, snapshot: () => PruneTables) {
  return {
    from: (table: unknown) => {
      const tableName = getTableName(table as never) as 'events' | 'outbox'
      return {
        where: (cond: unknown): FakeSubquery => {
          const colKey = Object.keys(cols)[0] as string
          const col = cols[colKey]
          return {
            __table: tableName,
            __where: cond,
            __col: col,
            getSQL: () => cond,
            then: (resolve: (v: unknown[]) => void) => {
              const tables = snapshot()
              let n = 0
              for (const row of tables[tableName]) {
                if (evalCond(cond, { [tableName]: row } as Bindings, tables)) n += 1
              }
              resolve([{ [colKey]: n }])
            },
          }
        },
      }
    },
  }
}

/**
 * pruneOlderThan 의 `db.transaction(tx => ...)` 을 흉내내는 fake.
 *
 * 단순히 "쿼리가 나갔다"만 확인하면 pending 이벤트가 실제로 살아남는지, sent/dead
 * 만 있는 이벤트가 실제로 지워지는지는 증명하지 못한다 — 운영 DB에는 연결할 수
 * 없으므로(이 태스크의 안전 규칙), 이 fake가 drizzle이 실제로 만든 조건 트리를
 * 인메모리 두 표(events, outbox)에 대해 직접 평가한다(evalCond). outbox 삭제가
 * 먼저 실행되고 그 결과로 outboxRows 가 갱신된 "이후" events 삭제의 notExists
 * 서브쿼리가 평가되므로, 같은 트랜잭션 안에서의 가시성도 그대로 재현된다.
 *
 * delete().where() 는 `.returning()` 을 쓰지 않는 실제 구현과 똑같이 where() 자체가
 * 곧바로 await 대상이다 — postgres.js 의 Result(빈 배열 + count 프로퍼티)를 흉내내
 * `Object.assign([], { count })` 를 돌려준다. `.returning()` 을 아예 노출하지 않아,
 * 구현이 실수로 다시 그걸 호출하면 타입 에러로 즉시 드러난다.
 *
 * where()에 전달된 원본 조건도 테이블별로 기록해 둔다 — 구조 자체(어떤 컬럼을
 * 참조하는지)를 확인하는 테스트가 여전히 필요할 수 있어서다.
 */
function fakeTxDb(fixtures: PruneTables) {
  let eventsRows = [...fixtures.events]
  let outboxRows = [...fixtures.outbox]
  const deletedTables: string[] = []
  const outboxWhereConditions: unknown[] = []
  const eventsWhereConditions: unknown[] = []
  const snapshot = (): PruneTables => ({ events: eventsRows, outbox: outboxRows })

  const tx = {
    select: (cols: Record<string, unknown>) => fakeSelectChain(cols, snapshot),
    delete: (table: unknown) => {
      const name = getTableName(table as never) as 'events' | 'outbox'
      deletedTables.push(name)
      return {
        where: async (cond: unknown) => {
          if (name === 'outbox') outboxWhereConditions.push(cond)
          else eventsWhereConditions.push(cond)
          const tables = snapshot()
          if (name === 'outbox') {
            const kept: OutboxRow[] = []
            let removedCount = 0
            for (const row of outboxRows) {
              if (evalCond(cond, { outbox: row }, tables)) removedCount += 1
              else kept.push(row)
            }
            outboxRows = kept
            return Object.assign([], { count: removedCount })
          }
          const kept: EventRow[] = []
          let removedCount = 0
          for (const row of eventsRows) {
            if (evalCond(cond, { events: row }, tables)) removedCount += 1
            else kept.push(row)
          }
          eventsRows = kept
          return Object.assign([], { count: removedCount })
        },
      }
    },
  }
  const db = { transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) }
  return {
    db: db as unknown as Db,
    deletedTables,
    outboxWhereConditions,
    eventsWhereConditions,
    remaining: () => ({ events: eventsRows, outbox: outboxRows }),
  }
}

describe('pruneOlderThan', () => {
  const cutoff = new Date('2026-06-22T00:00:00Z')
  const old = new Date('2026-01-01T00:00:00Z') // cutoff보다 오래됨
  const recent = new Date('2026-07-01T00:00:00Z') // cutoff보다 최근

  it(
    '오래된 이벤트라도 pending 상태 outbox 행이 남아있으면 그 이벤트만 지우지 않고, ' +
      'pinned 로 드러낸다 — 지우면 outbox.event_id 외래키(ON DELETE no action) 위반으로 ' +
      '트랜잭션 전체가 롤백되어 보관 정책이 매번 조용히 실패하게 된다. ' +
      '이벤트가 하나뿐인 픽스처로는 상관 서브쿼리(eq(outbox.eventId, events.id))와 ' +
      '비상관 EXISTS(그냥 "outbox가 비었나")를 구별할 수 없다 — 뮤테이션 테스트가 ' +
      '실제로 그렇게 뚫렸다. 오래된 이벤트를 두 개 두고 pending 참조는 하나만 걸어야 ' +
      '상관관계가 실제로 평가되는지 드러난다',
    async () => {
      const { db, remaining } = fakeTxDb({
        events: [{ id: 1, firstSeenAt: old }, { id: 2, firstSeenAt: old }],
        outbox: [{ id: 901, eventId: 1, status: 'pending' }],
      })

      await expect(createPostgresStore(db).pruneOlderThan(cutoff)).resolves.toEqual({
        events: 1,
        outbox: 0,
        pinned: 1,
      })
      expect(remaining().events).toEqual([{ id: 1, firstSeenAt: old }])
    },
  )

  it('오래된 이벤트의 outbox 행이 전부 sent/dead면 이벤트와 outbox 행 모두 지우고 pinned는 0이다', async () => {
    const { db, remaining } = fakeTxDb({
      events: [{ id: 2, firstSeenAt: old }],
      outbox: [
        { id: 902, eventId: 2, status: 'sent' },
        { id: 903, eventId: 2, status: 'dead' },
      ],
    })

    const result = await createPostgresStore(db).pruneOlderThan(cutoff)

    expect(result).toEqual({ events: 1, outbox: 2, pinned: 0 })
    expect(remaining()).toEqual({ events: [], outbox: [] })
  })

  it('outbox 행이 아예 없는 오래된 이벤트는 지우고 pinned는 0이다', async () => {
    const { db, remaining } = fakeTxDb({
      events: [{ id: 3, firstSeenAt: old }],
      outbox: [],
    })

    const result = await createPostgresStore(db).pruneOlderThan(cutoff)

    expect(result).toEqual({ events: 1, outbox: 0, pinned: 0 })
    expect(remaining()).toEqual({ events: [], outbox: [] })
  })

  it('cutoff보다 최근인 이벤트는 outbox 상태와 무관하게 건드리지 않고 pinned에도 세지 않는다', async () => {
    const { db, remaining } = fakeTxDb({
      events: [{ id: 4, firstSeenAt: recent }],
      outbox: [{ id: 904, eventId: 4, status: 'sent' }],
    })

    const result = await createPostgresStore(db).pruneOlderThan(cutoff)

    expect(result).toEqual({ events: 0, outbox: 0, pinned: 0 })
    expect(remaining()).toEqual({
      events: [{ id: 4, firstSeenAt: recent }],
      outbox: [{ id: 904, eventId: 4, status: 'sent' }],
    })
  })

  it(
    'outbox를 events보다 먼저 지운다 — outbox.event_id는 events.id를 참조하는 ' +
      '외래키라, 순서가 바뀌면 제약 위반으로 트랜잭션이 통째로 롤백되어 보관 정책이 ' +
      '조용히 아무 일도 하지 않게 된다',
    async () => {
      const { db, deletedTables } = fakeTxDb({ events: [], outbox: [] })
      await createPostgresStore(db).pruneOlderThan(cutoff)

      expect(deletedTables).toEqual(['outbox', 'events'])
    },
  )

  it(
    'outbox 삭제 조건은 status 컬럼을 sent/dead 화이트리스트로 좁히고 pending은 ' +
      '허용 목록에 없다 — 화이트리스트 방식이라 나중에 상태값이 추가돼도(예: ' +
      "'retrying') 실수로 삭제 대상에 끼지 않는다",
    async () => {
      const { db, outboxWhereConditions } = fakeTxDb({ events: [], outbox: [] })
      await createPostgresStore(db).pruneOlderThan(cutoff)

      const cond = outboxWhereConditions[0]
      expect(collectColumns(cond)).toContain(outbox.status)
      expect(collectColumns(cond)).toContain(outbox.eventId)

      const values = collectParamValues(cond)
      expect(values).toEqual(expect.arrayContaining(['sent', 'dead']))
      expect(values).not.toContain('pending')
    },
  )

  it('events 삭제 조건은 first_seen_at < cutoff 를 쓴다', async () => {
    const { db, eventsWhereConditions } = fakeTxDb({ events: [], outbox: [] })
    await createPostgresStore(db).pruneOlderThan(cutoff)

    const cond = eventsWhereConditions[0]
    expect(collectColumns(cond)).toContain(events.firstSeenAt)
    expect(collectParamValues(cond)).toContain(cutoff)
  })
})
