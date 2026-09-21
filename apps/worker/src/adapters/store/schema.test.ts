import { describe, it, expect } from 'vitest'
import { events, outbox, apiUsage } from './schema.js'
import { getTableConfig } from 'drizzle-orm/pg-core'

describe('events 테이블', () => {
  it('(source_id, external_id) 유니크 제약을 가진다 — 중복 발송 차단의 근거', () => {
    const cfg = getTableConfig(events)
    const cols = cfg.uniqueConstraints.flatMap((u) => u.columns.map((c) => c.name))
    expect(cols).toEqual(expect.arrayContaining(['source_id', 'external_id']))
  })

  it('drop된 이벤트도 사유를 남길 수 있도록 rule이 not null이다', () => {
    const cfg = getTableConfig(events)
    const rule = cfg.columns.find((c) => c.name === 'rule')
    expect(rule?.notNull).toBe(true)
  })

  it(
    'first_seen_at 인덱스를 가진다 — 다이제스트의 집계 5개가 전부 이 컬럼으로 하루를 ' +
      '자르고, lastEventKstDate 가 기동마다 최대값을 찾는다',
    () => {
      const cfg = getTableConfig(events)
      const cols = cfg.indexes.map((i) => i.config.columns.map((c) => 'name' in c ? c.name : ''))
      expect(cols).toContainEqual(['first_seen_at'])
    },
  )
})

describe('outbox 테이블', () => {
  it('expires_at을 가진다 — 늦은 알림 포기의 근거', () => {
    const cfg = getTableConfig(outbox)
    expect(cfg.columns.map((c) => c.name)).toContain('expires_at')
  })

  it(
    '(status, next_attempt_at) 인덱스를 가진다 — claimPending 이 매 사이클 돌기 때문에 ' +
      '인덱스가 없으면 sent/dead 가 쌓일수록 순차 스캔 비용이 매 폴링 사이클에 그대로 얹힌다',
    () => {
      const cfg = getTableConfig(outbox)
      const cols = cfg.indexes.map((i) => i.config.columns.map((c) => 'name' in c ? c.name : ''))
      expect(cols).toContainEqual(['status', 'next_attempt_at'])
    },
  )

  it(
    'event_id 인덱스를 가진다 — 외래키(ON DELETE no action)만으로는 인덱스가 생기지 않는다. ' +
      'events 에서 행을 지울 때마다 참조 무결성 트리거가 이 컬럼으로 outbox 를 훑으므로, ' +
      '인덱스가 없으면 pruneOlderThan 이 이벤트 삭제 건수 × outbox 행 수만큼 순차 스캔한다',
    () => {
      const cfg = getTableConfig(outbox)
      const cols = cfg.indexes.map((i) => i.config.columns.map((c) => 'name' in c ? c.name : ''))
      expect(cols).toContainEqual(['event_id'])
    },
  )
})

describe('api_usage 테이블', () => {
  it('(usage_date, source_id) 복합 PK를 가진다', () => {
    const cfg = getTableConfig(apiUsage)
    const pk = cfg.primaryKeys[0]
    expect(pk?.columns.map((c) => c.name)).toEqual(['usage_date', 'source_id'])
  })
})
