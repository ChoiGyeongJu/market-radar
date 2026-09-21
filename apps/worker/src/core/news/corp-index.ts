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
        // 이 등장이 경계 조건을 만족하면 매칭 가능.
        // '&' 는 삼성E&A·동원F&B 처럼 회사명 내부에 쓰이는 문자라 경계가
        // 아니다 — 영문/숫자 이웃과 똑같이 취급해야 KT&G 안의 "KT" 가
        // 별개 회사(KT, 030200)로 오귀속되지 않는다.
        if (!/[A-Za-z0-9&]/.test(before) && !/[A-Za-z0-9&]/.test(after)) {
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

/**
 * 뉴스 통용명 → 티커. DART 는 법인 등기명을 주는데 뉴스는 통용명을 쓴다.
 *
 * 주요 42개 종목으로 실측해 6개를 찾았다. 알고리즘으로 유도할 수 있는 규칙이
 * 아니라(현대자동차→현대차는 되지만 한국가스공사→한국가스공사는 그대로다)
 * 손으로 관리한다. 3a 운영 데이터의 no-corp-match 를 보고 늘린다.
 *
 * 한국전력은 누락이 아니라 오귀속을 고친다 — 등록명이 한국전력공사라
 * 기사의 "한국전력" 이 별개 상장사 "국전" 에 잡히고 있었다. 별칭(4자)이
 * 국전(2자)보다 길어 긴 이름 우선 규칙이 먼저 잡는다.
 *
 * KT&G 는 등록명이 "케이티앤지"라 뉴스 표기와 전혀 안 겹친다. `&` 를
 * 경계 문자에서 제외한 수정(matchCorp) 덕에 "KT&G" 안의 "KT" 가 별개
 * 회사(KT, 030200)로 오귀속되진 않지만, 별칭이 없으면 no-corp-match 로
 * 빠진다 — 그래서 별도로 추가한다.
 */
export const CORP_ALIASES: ReadonlyArray<{ alias: string; ticker: string }> = [
  { alias: '현대차', ticker: '005380' },
  { alias: '네이버', ticker: '035420' },
  { alias: 'KT', ticker: '030200' },
  { alias: '삼성화재', ticker: '000810' },
  { alias: '에쓰오일', ticker: '010950' },
  { alias: '한국전력', ticker: '015760' },
  { alias: 'KT&G', ticker: '033780' },
]
