import { describe, it, expect } from 'vitest'
import { buildCorpIndex, matchCorp } from './corp-index.js'

const INDEX = buildCorpIndex([
  { name: '삼성전자', ticker: '005930' },
  { name: '한미약품', ticker: '128940' },
  { name: '대상', ticker: '001680' },        // 일반 단어
  { name: '한창', ticker: '005110' },        // 일반 부사
  { name: '진영', ticker: '285800' },        // 사람 이름
  { name: 'CJ', ticker: '001040' },          // 2글자 영문
  { name: 'SK', ticker: '001200' },          // 경계 테스트용
  { name: 'LG', ticker: '003550' },          // 경계 테스트용
  { name: 'CJ대한통운', ticker: '000023' },   // 혼합 이름 테스트용
  { name: 'SK하이닉스', ticker: '000660' },  // 혼합 한글 이름
  { name: 'LG전자', ticker: '003550' },      // 혼합 한글 이름
  { name: 'DB하이텍', ticker: '000000' },    // 혼합 한글 이름
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

  it('라틴 약어는 단어 경계가 필요하다', () => {
    // SKY캐슬에서 SK 부분과 매칭하면 안 됨 (단어 경계 없음)
    expect(matchCorp('SKY캐슬 후속작 관련주 급등, 증시 훈풍', INDEX)).toBeNull()
    // LGBT에서 LG 부분과 매칭하면 안 됨 (단어 경계 없음)
    expect(matchCorp('LGBT 인권단체 성명 발표, 코스피 급등과 무관', INDEX)).toBeNull()
  })

  it('라틴 약어 경계 처리 — 독립 토큰은 매칭한다', () => {
    // CJ대한통운 (혼합) — 더 길어서 우선
    expect(matchCorp('CJ대한통운 주가 급등', INDEX)?.ticker).toBe('000023')
    // SK 독립 토큰 (문맥 신호 있음)
    expect(matchCorp('SK 주가 급등', INDEX)?.ticker).toBe('001200')
    // CJ 독립 토큰 (문맥 신호 있음)
    expect(matchCorp('CJ 주가 급등', INDEX)?.ticker).toBe('001040')
    // CJ 독립 토큰 (문맥 신호 없음) — 모호하면 문맥 필요
    expect(matchCorp('CJ 대한통운 파업', INDEX)).toBeNull()
  })

  it('라틴 약어는 모든 등장을 스캔한다 — 첫 등장이 경계 밖이어도 나중 등장이 경계 내면 매칭', () => {
    // 첫 등장: SKT (경계 밖), 나중 등장: SK (경계 내) → SK로 매칭해야 함
    expect(matchCorp('SKT 요금제 개편, SK 주가 강세', INDEX)?.ticker).toBe('001200')
    // 첫 등장: LGU+ (경계 밖), 나중 등장: LG (경계 내) → LG로 매칭해야 함
    expect(matchCorp('LGU+ 요금 인하, LG 주가 급등', INDEX)?.ticker).toBe('003550')
    // 첫 등장: NSK (경계 밖), 나중 등장: SK (경계 내) → SK로 매칭해야 함
    expect(matchCorp('NSK 베어링 수입, SK 증시 강세', INDEX)?.ticker).toBe('001200')
    // 첫 등장: SKY캐슬 (경계 밖), 나중 등장: SK (경계 내) → SK로 매칭해야 함
    expect(matchCorp('SKY캐슬 방영, SK 주가 급등', INDEX)?.ticker).toBe('001200')
  })

  it('혼합 한글 이름은 경계 확인 없이 매칭한다', () => {
    // SK하이닉스는 혼합 이름이므로 경계 확인 안 함
    expect(matchCorp('SK하이닉스 목표주가 상향', INDEX)?.ticker).toBe('000660')
    // LG전자도 경계 확인 없이 매칭
    expect(matchCorp('LG전자 실적 발표', INDEX)?.ticker).toBe('003550')
    // DB하이텍도 경계 확인 없이 매칭
    expect(matchCorp('DB하이텍 주가 20만원 목표', INDEX)?.ticker).toBe('000000')
  })
})
