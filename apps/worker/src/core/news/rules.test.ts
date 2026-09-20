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

  // 화재 키워드 특이화 테스트 — 회사명 일부나 squash 부산물로 잘못 매칭되는 것을 방지한다.
  describe('화재 키워드 특이화', () => {
    const FIRE_INDEX = buildCorpIndex([
      { name: '흥국화재', ticker: '000030' },
      { name: '삼성화재해상보험', ticker: '000810' },
      { name: '한미약품', ticker: '128940' },
    ])

    it('회사명에 화재가 포함된 경우 — 흥국화재, 3분기 실적 발표', () => {
      // 과거: keyword:화재로 오탐
      // 지금: 다른 신호(실적발표)로 통과하거나 drop
      const v = evaluateNews(ev('흥국화재, 3분기 실적 발표'), FIRE_INDEX, '')
      if (v.action === 'pass') {
        expect(v.rule).toBe('keyword:실적발표')
      } else {
        expect(v).toEqual({ action: 'drop', reason: 'no-keyword-match' })
      }
    })

    it('회사명에 화재가 포함되고 다른 신호도 없는 경우 — 흥국화재 신임 대표 선임', () => {
      // 과거: keyword:화재로 오탐
      // 지금: drop
      expect(evaluateNews(ev('흥국화재 신임 대표 선임'), FIRE_INDEX, '')).toEqual({
        action: 'drop', reason: 'no-keyword-match',
      })
    })

    it('회사명에 화재가 포함된 긴 회사명 — 삼성화재해상보험 사옥 이전', () => {
      // 과거: keyword:화재로 오탐
      // 지금: drop
      expect(evaluateNews(ev('삼성화재해상보험 사옥 이전'), FIRE_INDEX, '')).toEqual({
        action: 'drop', reason: 'no-keyword-match',
      })
    })

    it('squash 부산물로 잘못된 화재 매칭 — 대형화 + 재무구조 = 화재', () => {
      // "사업 대형화 재무구조 개선" → "사업대형화재무구조개선" 에 화재 포함
      // 과거: keyword:화재로 오탐
      // 지금: drop
      expect(evaluateNews(ev('한미약품, 사업 대형화 재무구조 개선 계획 발표'), FIRE_INDEX, '')).toEqual({
        action: 'drop', reason: 'no-keyword-match',
      })
    })

    it('실제 공장 화재는 공장화재로 매칭된다', () => {
      // 실제 화재 뉴스: 공장화재 키워드가 정상 작동
      const v = evaluateNews(ev('삼성전자 공장 화재로 생산 중단'), INDEX, '')
      expect(v).toMatchObject({ action: 'pass', tier: 'high', rule: 'keyword:공장화재' })
    })

    it('화재사고 키워드로도 매칭된다', () => {
      // 공장 화재사고는 공장화재를 먼저 만나므로 keyword:공장화재로 매칭되지만,
      // 순수 화재사고 상황도 테스트한다
      const v = evaluateNews(ev('한미약품 화재사고 발생'), INDEX, '')
      expect(v).toMatchObject({ action: 'pass', tier: 'high', rule: 'keyword:화재사고' })
    })
  })
})
