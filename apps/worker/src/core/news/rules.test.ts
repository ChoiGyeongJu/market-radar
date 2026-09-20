import { describe, it, expect } from 'vitest'
import type { NormalizedEvent } from '@app/shared'
import { buildCorpIndex } from './corp-index.js'
import { evaluateNews } from './rules.js'

const INDEX = buildCorpIndex([
  { name: '한미약품', ticker: '128940' },
  { name: '삼성전자', ticker: '005930' },
  { name: '대상', ticker: '001680' },
])

const ev = (title: string): NormalizedEvent => ({
  sourceId: 'news:yna', externalId: 'x', occurredAt: null, firstSeenAt: new Date(),
  title, url: 'https://example.com/a', raw: {},
})

describe('evaluateNews', () => {
  it('표현 변형은 키워드에서만 흡수한다 — 종목명은 원문', () => {
    expect(evaluateNews(ev('한미약품 계약 체결'), INDEX, '')).toMatchObject({ action: 'pass' })
  })

  it('종목이 안 잡히면 drop한다', () => {
    expect(evaluateNews(ev('오늘 서울 날씨 맑음'), INDEX, '')).toEqual({
      action: 'drop', reason: 'no-corp-match',
    })
  })

  it('종목은 잡히지만 영향 키워드가 없으면 drop한다', () => {
    expect(evaluateNews(ev('한미약품 사옥 이전'), INDEX, '')).toEqual({
      action: 'drop', reason: 'no-keyword-match',
    })
  })

  it('critical 키워드는 critical로 통과한다', () => {
    const v = evaluateNews(ev('한미약품 대표 횡령 혐의 압수수색'), INDEX, '')
    expect(v).toMatchObject({ action: 'pass', tier: 'critical' })
  })

  it('표현 변형을 흡수한다 — 수주/계약 체결/공급 계약', () => {
    for (const t of ['한미약품 수주 공시', '한미약품 계약 체결', '한미약품 공급 계약']) {
      expect(evaluateNews(ev(t), INDEX, '')).toMatchObject({ action: 'pass' })
    }
  })

  it('종목이 description에만 있으면 drop한다 — 오귀속을 막는다', () => {
    // 실측: "한섬, 자사주 매입·소각" 이 본문의 모회사 때문에 현대백화점으로 잡혔다.
    expect(evaluateNews(ev('자사주 매입·소각 결정'), INDEX, '한미약품 계열사 소식')).toEqual({
      action: 'drop', reason: 'no-corp-match',
    })
  })

  it('critical 키워드가 description에만 있으면 critical로 올리지 않는다', () => {
    // 실측: "맥쿼리 가비아 공개매수 무산" 이 본문의 '상장폐지' 로 critical 이 됐다.
    expect(evaluateNews(ev('한미약품 공개매수 무산'), INDEX, '상장폐지 가능성도 거론된다')).toEqual({
      action: 'drop', reason: 'no-keyword-match',
    })
  })

  it('critical 키워드가 제목에 있으면 critical이다', () => {
    expect(evaluateNews(ev('한미약품, 200억 규모 유상증자 실시'), INDEX, ''))
      .toMatchObject({ action: 'pass', tier: 'critical' })
  })

  it('high 키워드는 description에만 있어도 판정에 쓴다', () => {
    const v = evaluateNews(ev('한미약품 관련 소식'), INDEX, '오늘 대규모 수주를 발표했다')
    expect(v).toMatchObject({ action: 'pass' })
  })

  it('공백을 지워 없던 종목명을 만들지 않는다', () => {
    // squash 를 종목 매칭에 쓰면 "삼성 전자제품" 이 "삼성전자제품" 이 되어
    // "삼성전자" 를 포함하게 된다. 종목 매칭은 원문으로 한다.
    const v = evaluateNews(ev('삼성 전자제품 수주 계약'), INDEX, '')
    expect(v).toEqual({ action: 'drop', reason: 'no-corp-match' })
  })

  it('모호한 종목명은 문맥 신호가 있어야 통과한다', () => {
    expect(evaluateNews(ev('조사 대상 확대 계약 체결'), INDEX, '')).toEqual({
      action: 'drop', reason: 'no-corp-match',
    })
    expect(evaluateNews(ev('대상 주가 급등, 수주 공시'), INDEX, '')).toMatchObject({
      action: 'pass',
    })
  })

  it('rule 문자열에 키워드를 남긴다 — 튜닝 근거가 된다', () => {
    const v = evaluateNews(ev('삼성전자 수주 계약'), INDEX, '')
    if (v.action !== 'pass') throw new Error('pass여야 한다')
    expect(v.rule).toMatch(/^keyword:/)
  })
})
