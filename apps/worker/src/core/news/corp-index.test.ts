import { describe, it, expect } from 'vitest'
import { buildCorpIndex, matchCorp } from './corp-index.js'

const INDEX = buildCorpIndex([
  { name: '삼성전자', ticker: '005930' },
  { name: '한미약품', ticker: '128940' },
  { name: '대상', ticker: '001680' },      // 일반 단어
  { name: '한창', ticker: '005110' },      // 일반 부사
  { name: '진영', ticker: '285800' },      // 사람 이름
  { name: 'CJ', ticker: '001040' },        // 2글자 영문
])

describe('matchCorp', () => {
  it('명확한 종목명을 매칭한다', () => {
    expect(matchCorp('한미약품, 기술수출 계약 체결', INDEX)?.ticker).toBe('128940')
  })

  it('가장 긴 이름을 우선한다', () => {
    const idx = buildCorpIndex([
      { name: '삼성', ticker: '000000' },
      { name: '삼성전자', ticker: '005930' },
    ])
    expect(matchCorp('삼성전자 3분기 실적', idx)?.ticker).toBe('005930')
  })

  it('모호한 이름은 문맥 신호 없이 매칭하지 않는다', () => {
    expect(matchCorp('한창 진행 중인 협상', INDEX)).toBeNull()
    expect(matchCorp('조사 대상 기업이 늘었다', INDEX)).toBeNull()
    expect(matchCorp('김진영 선수가 우승했다', INDEX)).toBeNull()
  })

  it('모호한 이름도 문맥 신호가 있으면 매칭한다', () => {
    expect(matchCorp('대상 주가가 상한가를 기록했다', INDEX)?.ticker).toBe('001680')
    expect(matchCorp('한창 공시 정정 신고', INDEX)?.ticker).toBe('005110')
  })

  it('2글자 영문 약어도 모호한 이름으로 다룬다', () => {
    expect(matchCorp('CJ 대한통운 파업', INDEX)).toBeNull()
    expect(matchCorp('CJ 주가 급등', INDEX)?.ticker).toBe('001040')
  })

  it('매칭이 없으면 null', () => {
    expect(matchCorp('오늘 날씨는 맑겠습니다', INDEX)).toBeNull()
  })
})
