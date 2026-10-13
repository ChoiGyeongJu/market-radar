/**
 * 거시 트랙의 1차 게이트 — **주체 + 행위 조합**(스펙 §3).
 *
 * 인물·국가명 단독으로는 통과시키지 않는다. "트럼프" 단독 매칭은 하루 수백 건의
 * 정치 가십을 끌어온다(실측: 수집 1,072건 중 제목에 "트럼프" 40건, 그중 관세·제재
 * 같은 행위가 붙은 것은 1건). 같은 카테고리 안에서 주체와 행위가 **둘 다** 제목에
 * 있어야 한다.
 *
 * 이 게이트는 후보를 고를 뿐 발송을 결정하지 않는다. 발송은 클러스터(여러 매체가
 * 동시에 썼는가)가 정한다 — core/news/cluster.ts.
 *
 * 패턴이 문자열이 아니라 정규식인 이유는 한 글자 약칭의 오탐 때문이다(실측 제목에서
 * 확인한 것들): `北京`(베이징)·`北美`(북미)가 북한으로, `中企`(중소기업)가 중국으로,
 * `EUV` 가 EU 로, `유가증권`·`유가족` 이 유가로, `다우기술` 이 다우지수로, `달러` 가
 * "러"(러시아)로 잡힌다 — 제목에서 러시아는 "러 공습" 처럼 한 글자로 자주 쓰여 빼지
 * 않고, 앞뒤가 한글이 아닐 때만 인정한다. 정전은 휴전이 아니라 정전 사고일 때가 더 많아 넣지 않는다.
 *
 * 행위는 공백을 지운 제목에서 찾는다 — `금리 인하` 와 `금리인하` 를 같게 본다.
 * 주체는 공백을 살린 제목에서 찾는다 — 단어 경계가 필요한 이름이 있다(HANGUL_START).
 */

export type MacroCategory = 'rates' | 'trade' | 'geo' | 'market'

export type MacroMatch = {
  /** 클러스터 키. `카테고리:주체:행위` — 같은 사건을 다르게 쓴 제목들이 같은 키로 모인다. */
  key: string
  category: MacroCategory
}

type Term = readonly [pattern: RegExp, canonical: string]

/** 라틴 약어는 앞뒤가 라틴 문자가 아닐 때만 — `EUV` 의 EU, `FEDEX` 의 FED 를 막는다. */
const latin = (s: string) => new RegExp(`(?<![A-Za-z])${s}(?![A-Za-z])`)
const lit = (s: string) => new RegExp(s)
/**
 * 한글 단어의 첫머리일 때만. `이란` 은 조사로 더 자주 나온다 — "전쟁이란 무엇인가"
 * 가 이란 + 전쟁으로 잡히면 안 된다. 앞 글자가 한글이 아니어야(공백·문장부호·
 * `美·이란` 의 가운뎃점·문두) 국가명으로 본다.
 */
const HANGUL_START = (s: string) => new RegExp(`(?<![가-힣])${s}`)

const NORTH_KOREA: Term[] = [
  [lit('북한'), '북한'], [/北(?![美京極歐])/, '북한'], [lit('합참'), '북한'],
]
const CHINA: Term[] = [[lit('중국'), '중국'], [/中(?![企東銀])/, '중국']]
const USA: Term[] = [
  [lit('트럼프'), '미국'], [lit('백악관'), '미국'], [lit('美'), '미국'], [lit('미국'), '미국'],
  [latin('USTR'), '미국'], [lit('상무부'), '미국'],
]

/**
 * 카테고리 순서가 우선순위다. 무역이 지정학보다 앞이다 — "美中 무역전쟁" 은 전쟁이
 * 아니라 무역 사건이다. 각 목록 안의 순서도 우선순위다(행위는 구체적인 것부터).
 */
const LEXICON: ReadonlyArray<{ category: MacroCategory; subjects: Term[]; actions: Term[] }> = [
  {
    category: 'rates',
    subjects: [
      [lit('연준'), '연준'], [latin('Fed'), '연준'], [latin('FOMC'), '연준'], [lit('파월'), '연준'],
      [HANGUL_START('한은'), '한은'], [lit('한국은행'), '한은'], [lit('금통위'), '한은'],
      [latin('ECB'), 'ECB'], [lit('유럽중앙은행'), 'ECB'],
      [latin('BOJ'), 'BOJ'], [lit('일본은행'), 'BOJ'], [lit('日銀'), 'BOJ'],
      [lit('인민은행'), '인민은행'],
    ],
    // 방향(인상·인하·동결)은 키에서 지운다 — 같은 결정을 매체마다 "동결", "인하
    // 보류" 로 달리 쓰고, 방향은 메시지에 쓰지도 않는다(제목을 그대로 보낸다).
    actions: [
      [lit('빅컷'), '금리'], [lit('인하'), '금리'], [lit('빅스텝'), '금리'],
      [lit('인상'), '금리'], [lit('동결'), '금리'],
    ],
  },
  {
    category: 'trade',
    subjects: [...USA, ...CHINA, [latin('EU'), 'EU'], [lit('유럽연합'), 'EU']],
    actions: [
      [lit('무역전쟁'), '무역전쟁'], [lit('관세'), '관세'],
      [lit('수출통제'), '수출통제'], [lit('수출규제'), '수출통제'],
      [lit('무역합의'), '무역합의'], [lit('무역협상'), '무역협상'],
    ],
  },
  {
    category: 'geo',
    subjects: [
      ...NORTH_KOREA,
      [lit('이스라엘'), '이스라엘'], [HANGUL_START('이란'), '이란'], [lit('러시아'), '러시아'], [/(?<![가-힣])러(?![가-힣])/, '러시아'],
      [lit('우크라'), '우크라이나'], [lit('대만'), '대만'], [lit('하마스'), '하마스'],
      [lit('헤즈볼라'), '헤즈볼라'], [lit('후티'), '후티'], [lit('미군'), '미국'],
      [lit('나토'), '나토'], [latin('NATO'), '나토'],
      ...CHINA,
    ],
    actions: [
      [lit('핵실험'), '핵실험'], [lit('탄도미사일'), '미사일'], [lit('미사일'), '미사일'],
      [lit('발사체'), '미사일'], [lit('공습'), '공습'], [lit('폭격'), '공습'],
      [lit('침공'), '전쟁'], [lit('교전'), '전쟁'], [lit('전쟁'), '전쟁'],
      [lit('휴전'), '휴전'],
    ],
  },
  {
    category: 'market',
    subjects: [
      [lit('코스피'), '코스피'], [lit('코스닥'), '코스닥'], [lit('나스닥'), '나스닥'],
      [/다우(?!기술|데이타|데이터)/, '다우'], [lit('S&P'), 'S&P'], [lit('닛케이'), '닛케이'],
      [/유가(?!증권|족)/, '유가'], [lit('환율'), '환율'],
    ],
    // 급락·급등은 `급변` 하나로 묶는다. 주체와 행위의 짝을 위치로 맞추지 않으므로
    // "코스피 4% 하락…유가 급등" 이 코스피 급등으로 잡힌다(실측). 방향을 키에 두면
    // 같은 사건이 두 키로 갈라지고, 방향은 어차피 메시지에 쓰지 않는다. 사이드카·
    // 서킷브레이커는 급변이 이미 나간 뒤의 별도 사건이라 따로 둔다.
    actions: [
      [lit('서킷브레이커'), '서킷브레이커'], [lit('사이드카'), '사이드카'],
      [lit('폭락'), '급변'], [lit('급락'), '급변'], [lit('폭등'), '급변'], [lit('급등'), '급변'],
    ],
  },
]

function first(terms: readonly Term[], text: string): string | null {
  for (const [pattern, canonical] of terms) if (pattern.test(text)) return canonical
  return null
}

export function matchMacro(title: string): MacroMatch | null {
  // 주체는 공백을 살린 제목에서, 행위는 공백을 지운 제목에서 찾는다. 주체 쪽에
  // 단어 경계가 필요한 이름이 있다(HANGUL_START) — 공백을 지우면 그 경계가 사라진다.
  const spaced = title.replace(/\s+/g, ' ')
  const squashed = title.replace(/\s+/g, '')
  for (const { category, subjects, actions } of LEXICON) {
    const subject = first(subjects, spaced)
    if (!subject) continue
    const action = first(actions, squashed)
    if (!action) continue
    return { key: `${category}:${subject}:${action}`, category }
  }
  return null
}

/**
 * 속보 표시. 통신사·언론사가 붙이는 이 머리표는 그 자체로 "지금 중요하다"는 판정이다 —
 * 클러스터의 매체 수와 같은 성격의 신호다. 실측에서 우리 피드 구성으로는 북한 탄도미사일
 * 발사(2026-10-12)를 연합 외에 뉴시스 한 곳만 5시간 뒤에 실어, 매체 수만으로는 놓쳤다.
 */
export function isBreaking(title: string): boolean {
  return /^\s*\[(속보|1보|긴급)\]/.test(title)
}
