import { describe, it, expect } from 'vitest'
import { retentionCutoff, RETENTION_DAYS } from './retention.js'

describe('retentionCutoff', () => {
  it('90일 전을 돌려준다', () => {
    expect(RETENTION_DAYS).toBe(90)
    expect(retentionCutoff(new Date('2026-09-20T00:00:00Z')).toISOString())
      .toBe('2026-06-22T00:00:00.000Z')
  })

  it('시계를 읽지 않는다 — 같은 입력에 같은 출력', () => {
    const now = new Date('2026-01-01T12:34:56Z')
    expect(retentionCutoff(now)).toEqual(retentionCutoff(now))
  })
})
