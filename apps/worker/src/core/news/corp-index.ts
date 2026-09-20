/**
 * 뉴스 본문에서 상장사를 찾는다. DART 의 stock_code 게이트와 같은 역할이다.
 *
 * 실측(스펙 §5.1) — 4주치 공시에 등장한 상장사 1,895개 중 뉴스 매칭에서
 * 오탐을 내는 이름은 55개(2.9%)뿐이다. 나머지 1,840개는 단독 매칭이 안전하다.
 * 그 55개만 문맥 신호를 요구한다.
 */
export type CorpEntry = { name: string; ticker: string }

export type CorpIndex = {
  /** 이름 길이 내림차순. "삼성"이 "삼성전자"를 가로채지 않게 한다. */
  readonly byLength: readonly CorpEntry[]
}

/**
 * 단독 매칭을 인정하지 않는 이름들. 세 부류다 —
 *   일반 단어(대상·한창·노을…), 흔한 사람 이름(성우·진영·우진…),
 *   2글자 영문 약어(CJ·DB·LG…).
 * 실측 기준이며 3a 운영 데이터로 재측정한다(스펙 §5.1 각주).
 */
export const AMBIGUOUS_NAMES: ReadonlySet<string> = new Set([
  // 일반 단어
  '대상', '한창', '노을', '동양', '남성', '전방', '진도', '레이', '캐리', '대동',
  '동방', '상보', '우성', '무학', '신원', '선진', '동서', '대교', '알트', '테스',
  '금비', '본느', '누보', '아톤', '야스', '도부', '원림', '청보', '아하',
  // 흔한 사람 이름
  '성우', '진영', '우진', '유신', '태성', '덕성', '서한', '연우', '우양', '영흥',
  // 2글자 영문 약어
  '3S', 'CJ', 'CS', 'DB', 'DL', 'E1', 'E8', 'EG', 'GS', 'KD', 'LF', 'LG', 'LS',
  'NC', 'SG', 'SK',
])

/**
 * 모호한 이름을 회사로 인정하기 위해 같은 텍스트에 있어야 하는 신호.
 * 문장 단위가 아니라 텍스트 전체에서 찾는다 — 뉴스 제목은 짧아서 문장을
 * 나눌 만큼 길지 않은 경우가 대부분이다.
 */
const CONTEXT_SIGNALS = [
  '주가', '증시', '상장', '공시', '실적', '거래량', '코스피', '코스닥',
  '상한가', '하한가', '급등', '급락', '영업이익', '매출', '주식', '시총',
] as const

export function buildCorpIndex(entries: readonly CorpEntry[]): CorpIndex {
  return { byLength: [...entries].sort((a, b) => b.name.length - a.name.length) }
}

export function matchCorp(text: string, index: CorpIndex): CorpEntry | null {
  const hasContext = CONTEXT_SIGNALS.some((s) => text.includes(s))
  for (const e of index.byLength) {
    if (!text.includes(e.name)) continue

    // 라틴 문자만 포함된 이름은 단어 경계를 확인해야 한다.
    // SK가 SKY에 포함되면 안 되고, 한미약품,나 SK하이닉스처럼
    // 한글 문자와 연결된 것은 경계 없이 매칭된다 (정렬 순서로 해결됨).
    // 첫 등장이 경계 내 아니어도 다음 등장이 경계 내면 괜찮다.
    // SKT 요금, SK 주가 → SK는 두 번째 등장에서 매칭해야 한다.
    if (/^[A-Za-z0-9]+$/.test(e.name)) {
      let idx = text.indexOf(e.name)
      let hasValidBoundary = false
      while (idx !== -1 && !hasValidBoundary) {
        const before = idx === 0 ? ' ' : text[idx - 1]!
        const after = idx + e.name.length >= text.length ? ' ' : text[idx + e.name.length]!
        // 이 등장이 경계 조건을 만족하면 매칭 가능
        if (!/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) {
          hasValidBoundary = true
        }
        idx = text.indexOf(e.name, idx + 1)
      }
      if (!hasValidBoundary) continue
    }

    if (AMBIGUOUS_NAMES.has(e.name) && !hasContext) continue
    return e
  }
  return null
}
