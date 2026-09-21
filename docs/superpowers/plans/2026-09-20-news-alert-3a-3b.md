# 뉴스 알림 3a + 3b 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RSS 뉴스를 종목과 연결해 선별 발송하고, 판정과 무관하게 전량 저장하되 저장량이 평형에 들도록 보관·백업 정책을 붙인다.

**Architecture:** 기존 헥사고날 구조를 그대로 쓴다. 새로 만드는 것은 `adapters/sources/rss.ts`(어댑터)와 `core/news/*`(순수 룰)뿐이고, 중복제거·outbox·재시도·레이트리밋·하트비트·다이제스트는 손대지 않는다. 다만 `runCycle` 이 단일 소스 전제로 짜여 있어(`deps.source`, 단일 `seen`, `incrementApiUsage(source.id)`) **다중 소스로 일반화하는 리팩터링이 Task 6 에 들어간다.** 소스마다 폴링 주기·예산·판정 함수가 다르므로 `SourcePlan` 으로 묶어 전달한다.

**Tech Stack:** TypeScript (Node 24 strip-only), pnpm workspace, vitest, drizzle-orm + postgres.js, zod, pino. 신규 의존성 `fflate`(DART corpCode ZIP 해제, 순수 JS·네이티브 없음).

**Spec:** [`docs/superpowers/specs/2026-09-20-news-alert-design.md`](../specs/2026-09-20-news-alert-design.md)

## Global Constraints

- **Node 24 strip-only TypeScript** — parameter property, `enum`, `namespace`, decorator 를 쓰지 않는다. vitest/esbuild 는 통과시키지만 런타임이 거부하므로 **테스트로 잡히지 않는다.**
- **NodeNext 모듈 해석** — 모든 상대 import 에 `.js` 확장자를 붙인다 (`./rules.js`). `.ts` 소스를 직접 실행할 수 없고 항상 `tsc` 후 `node dist/main.js` 로 돈다.
- **`core/` 는 순수해야 한다** — 시계·네트워크·DB·난수 금지. 시각은 파라미터로 받는다.
- **유사투자자문 금지** — 호재/악재 판정, 목표가, 매수/매도 의견을 생성하지 않는다. 영향 판정은 고르는 데만 쓰고 메시지에 표시하지 않는다.
- **저작권** — RSS `description` 원문을 **발송하지 않고 저장하지도 않는다.** 판정에만 쓰고 버린다.
- **뉴스 `raw` 는 축소한다** — 제목·링크·매체·발행시각만. 스펙 §6.2.
- **`pubDate` 를 신뢰하지 않는다** — 발송 판단은 `firstSeenAt` 으로 한다. 스펙 §4.3.
- 커밋 메시지는 한국어, 본문에 근거를 남긴다. 기존 커밋 스타일을 따른다.

---

### Task 1: RSS 피드 파싱 (순수)

**Files:**
- Create: `apps/worker/src/core/news/rss.ts`
- Test: `apps/worker/src/core/news/rss.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `type RssItem = { guid: string; title: string; link: string; description: string; pubDate: Date | null }`, `parseRssFeed(xml: string): RssItem[]`

**Why:** 실측에서 피드가 HTML 엔티티를 그대로 준다(`&quot;80대 할머니&quot;`, `&#039;육서영 20점 폭발&#039;`). 디코딩하지 않으면 키워드 매칭이 조용히 실패하고, 발송 메시지에도 `&quot;` 가 그대로 찍힌다. DART 의 가운뎃점 사건과 같은 유형의 버그다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
import { describe, it, expect } from 'vitest'
import { parseRssFeed } from './rss.js'

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>&quot;80대 할머니 앞에서 우승&quot; 김민선</title>
    <link>https://example.com/a</link>
    <guid>https://example.com/a</guid>
    <description>&#039;육서영 20점&#039; 본문 일부</description>
    <pubDate>Sun, 20 Sep 2026 18:05:00 +0900</pubDate>
  </item>
  <item>
    <title>제목만 있는 기사</title>
    <link>https://example.com/b</link>
  </item>
</channel></rss>`

describe('parseRssFeed', () => {
  it('HTML 엔티티를 디코딩한다', () => {
    const items = parseRssFeed(FEED)
    expect(items[0]!.title).toBe('"80대 할머니 앞에서 우승" 김민선')
    expect(items[0]!.description).toBe("'육서영 20점' 본문 일부")
  })

  it('pubDate를 Date로 파싱한다', () => {
    const items = parseRssFeed(FEED)
    expect(items[0]!.pubDate?.toISOString()).toBe('2026-09-20T09:05:00.000Z')
  })

  it('guid가 없으면 link를 멱등키로 쓴다', () => {
    const items = parseRssFeed(FEED)
    expect(items[1]!.guid).toBe('https://example.com/b')
  })

  it('description과 pubDate가 없어도 파싱된다', () => {
    const items = parseRssFeed(FEED)
    expect(items[1]!.description).toBe('')
    expect(items[1]!.pubDate).toBeNull()
  })

  it('CDATA를 벗겨낸다', () => {
    const cdata = `<rss><channel><item><title><![CDATA[삼성전자, 수주 공시]]></title>
      <link>https://example.com/c</link></item></channel></rss>`
    expect(parseRssFeed(cdata)[0]!.title).toBe('삼성전자, 수주 공시')
  })

  it('망가진 XML은 빈 배열을 돌려준다 — 한 피드가 루프를 죽이면 안 된다', () => {
    expect(parseRssFeed('<rss><channel><item>')).toEqual([])
  })

  it('link가 없는 item은 버린다 — 멱등키를 만들 수 없다', () => {
    const noLink = `<rss><channel><item><title>제목</title></item></channel></rss>`
    expect(parseRssFeed(noLink)).toEqual([])
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/core/news/rss.test.ts`
Expected: FAIL — `Cannot find module './rss.js'`

- [ ] **Step 3: 최소 구현을 쓴다**

```ts
/**
 * RSS 2.0 파싱. 의존성 없이 정규식으로 처리한다 — 우리가 읽는 필드는
 * item/title/link/guid/description/pubDate 여섯 개뿐이고, XML 파서를 들이면
 * 그만큼 공격면과 번들이 는다.
 *
 * 실측(스펙 §4.2)에서 국내 피드들이 HTML 엔티티를 그대로 준다:
 * `&quot;80대 할머니&quot;`, `&#039;육서영 20점 폭발&#039;`. 디코딩하지 않으면
 * 키워드 매칭이 조용히 실패하고 발송 메시지에도 그대로 찍힌다.
 */
export type RssItem = {
  /** 멱등키. guid 가 없으면 link 를 쓴다. */
  guid: string
  title: string
  link: string
  /** 판정에만 쓰고 저장·발송하지 않는다 (스펙 §4.3, 저작권). */
  description: string
  /** 매체가 미래 시각을 주는 경우가 있어 신뢰하지 않는다 (스펙 §4.3). */
  pubDate: Date | null
}

const ITEM_RE = /<item[\s>][\s\S]*?<\/item>/gi

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

/** `&quot;` `&#039;` `&#x27;` 를 실제 문자로 되돌린다. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => NAMED[n.toLowerCase()] ?? m)
}

function tag(xml: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml)
  if (!m) return ''
  const raw = m[1] ?? ''
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw)
  return decodeEntities(cdata ? cdata[1]! : raw).trim()
}

export function parseRssFeed(xml: string): RssItem[] {
  const out: RssItem[] = []
  for (const block of xml.match(ITEM_RE) ?? []) {
    const link = tag(block, 'link')
    // 멱등키를 만들 수 없는 item 은 버린다. 받아들이면 같은 기사를 매 사이클
    // 새 이벤트로 기록하게 된다.
    if (!link) continue
    const pd = tag(block, 'pubDate')
    const parsed = pd ? new Date(pd) : null
    out.push({
      guid: tag(block, 'guid') || link,
      title: tag(block, 'title'),
      link,
      description: tag(block, 'description'),
      pubDate: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
    })
  }
  return out
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/core/news/rss.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: 커밋**

```bash
git add apps/worker/src/core/news/rss.ts apps/worker/src/core/news/rss.test.ts
git commit -m "feat(news): RSS 2.0 파싱 — HTML 엔티티 디코딩 포함

실측에서 국내 피드가 &quot; &#039; 를 그대로 준다. 디코딩하지 않으면
키워드 매칭이 조용히 실패하고 발송 메시지에도 그대로 찍힌다.

link 가 없는 item 은 버린다 — 멱등키를 만들 수 없어 받아들이면 같은
기사를 매 사이클 새 이벤트로 기록하게 된다."
```

---

### Task 2: 상장사 매칭 (순수)

**Files:**
- Create: `apps/worker/src/core/news/corp-index.ts`
- Test: `apps/worker/src/core/news/corp-index.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `type CorpEntry = { name: string; ticker: string }`, `type CorpIndex`, `buildCorpIndex(entries: CorpEntry[]): CorpIndex`, `matchCorp(text: string, index: CorpIndex): CorpEntry | null`, `AMBIGUOUS_NAMES: ReadonlySet<string>`

**Why:** 스펙 §5.1. 상장사 1,895개 중 55개가 일반 단어·사람 이름·2글자 영문 약어와 겹친다. 이 55개를 단독 매칭으로 통과시키면 `"한창"` 이 들어간 모든 기사가 종목 뉴스가 된다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
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
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/core/news/corp-index.test.ts`
Expected: FAIL — `Cannot find module './corp-index.js'`

- [ ] **Step 3: 최소 구현을 쓴다**

```ts
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
    if (AMBIGUOUS_NAMES.has(e.name) && !hasContext) continue
    return e
  }
  return null
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/core/news/corp-index.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add apps/worker/src/core/news/corp-index.ts apps/worker/src/core/news/corp-index.test.ts
git commit -m "feat(news): 상장사 매칭 — 모호한 55개는 문맥 신호를 요구

실측(스펙 §5.1)에서 상장사 1,895개 중 오탐 위험은 55개(2.9%)뿐이다.
일반 단어(대상·한창), 사람 이름(진영·성우), 2글자 영문 약어(CJ·DB).
나머지 1,840개는 단독 매칭이 안전하다.

이름 길이 내림차순으로 순회한다 — '삼성'이 '삼성전자'를 가로채면
티커가 틀린 채로 발송된다."
```

---

### Task 3: 뉴스 룰 엔진 (순수)

**Files:**
- Create: `apps/worker/src/core/news/keywords.ts`, `apps/worker/src/core/news/rules.ts`
- Test: `apps/worker/src/core/news/rules.test.ts`

**Interfaces:**
- Consumes: Task 2 의 `CorpIndex`, `matchCorp`
- Produces: `evaluateNews(event: NormalizedEvent, index: CorpIndex, description: string): Verdict`

**Why:** 스펙 §5.2. DART 키워드셋을 재활용하되 뉴스 제목이 자유 형식이라 표현 변형(`수주`/`계약 체결`/`공급 계약`)을 흡수해야 한다. `description` 은 판정에만 쓰고 넘기지 않는다.

**실측이 두 가지를 강제했다.** 실제 상장사 1,895개 인덱스에 실시간 기사 461건을 물려 두 게이트를 통과시킨 결과:

- **종목은 제목에서만 찾는다.** 본문까지 보면 통과 18건 중 9건이 제목에 종목명이 없었고, 그 9건은 성격이 달랐다. `"고배당 기업 건보료 제외, 법적근거 마련해야"` 가 삼성전자로 잡혔는데 이건 정책 기사다. 더 나쁜 것은 `"한섬, 2028년까지 자사주 매입·소각"` 이 **현대백화점**으로 잡힌 경우다 — 본문의 모회사가 제목의 실제 주체를 밀어냈다. 노이즈가 아니라 **오귀속**이다. 우리가 발송하는 것은 제목과 링크뿐이라, 제목에 회사 이름이 없는 알림은 받는 사람에게 설명이 되지 않는다.
- **critical 티어는 키워드도 제목에 있어야 한다.** 실측의 최악 오탐이 그 티어였다 — `"맥쿼리 가비아 공개매수 무산"` 이 본문의 `상장폐지` 때문에 critical 로 나갔다. 공개매수 무산은 상장폐지가 아니다. critical 은 병합을 건너뛰고 즉시 나가는 티어라 틀렸을 때 가장 비싸다.

`high`/`normal` 은 본문 키워드를 그대로 쓴다 — 제목만으로는 `"삼성전자, 3분기 실적 발표"` 가 호실적인지 어닝쇼크인지 알 수 없다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
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
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/core/news/rules.test.ts`
Expected: FAIL — `Cannot find module './rules.js'`

- [ ] **Step 3: `keywords.ts` 를 쓴다**

```ts
import type { Tier } from '@app/shared'

/**
 * 뉴스용 키워드. DART 키워드셋(core/dart/keywords.ts)과 사건 종류는 같지만
 * 표기가 다르다 — DART 는 `단일판매ㆍ공급계약체결` 같은 정형 제목이고,
 * 뉴스는 `수주` / `계약 체결` / `공급 계약` 으로 흩어진다.
 *
 * 공백을 제거한 텍스트에 대해 매칭하므로 여기 항목도 공백 없이 적는다.
 */
export const NEWS_CRITICAL: readonly string[] = [
  '횡령', '배임', '압수수색', '상장폐지', '거래정지', '회생절차', '파산',
  '유상증자', '무상증자', '감자결정', '분식회계', '영업정지',
]

export const NEWS_HIGH: readonly string[] = [
  '수주', '계약체결', '공급계약', '기술수출', '인수합병', '지분인수',
  '임상3상', '임상2상', '품목허가', '특허취득', '리콜', '화재',
  '실적발표', '영업이익', '어닝쇼크', '어닝서프라이즈', '자사주매입',
]

export const NEWS_NORMAL: readonly string[] = [
  '배당', '주주총회', '신제품', '업무협약', 'MOU', '공장증설',
]

export const NEWS_TIERS: readonly { tier: Tier; words: readonly string[] }[] = [
  { tier: 'critical', words: NEWS_CRITICAL },
  { tier: 'high', words: NEWS_HIGH },
  { tier: 'normal', words: NEWS_NORMAL },
]
```

- [ ] **Step 4: `rules.ts` 를 쓴다**

```ts
import type { NormalizedEvent, Verdict } from '@app/shared'
import { matchCorp, type CorpIndex } from './corp-index.js'
import { NEWS_TIERS } from './keywords.js'

/** 표현 변형을 흡수하기 위해 공백을 지운다 — `계약 체결` 과 `계약체결` 이 같아진다. */
function squash(s: string): string {
  return s.replace(/\s+/g, '')
}

/**
 * 뉴스 판정. DART 와 게이트 구조는 같지만 순서가 다르다 —
 * 종목 연결(게이트 1)이 DART 의 stock_code 게이트에 해당한다.
 *
 * `description` 은 판정에만 쓰고 **반환하지도 저장하지도 않는다**
 * (스펙 §4.3, 저작권). 제목만으로는 "삼성전자, 3분기 실적 발표"가
 * 호실적인지 어닝쇼크인지 알 수 없어 정확도가 크게 떨어진다.
 */
export function evaluateNews(
  event: NormalizedEvent, index: CorpIndex, description: string,
): Verdict {
  // 게이트 1 — 종목 연결. **제목에서만, 공백을 지우지 않고** 찾는다.
  //
  // 제목으로 한정하는 이유는 실측이다(기사 461건). 본문까지 보면 통과분의 절반이
  // 제목에 종목명이 없었고, 그중에는 본문의 모회사가 제목의 실제 주체를 밀어낸
  // 오귀속이 있었다 — "한섬, 자사주 매입·소각" 이 현대백화점으로 잡혔다. 발송
  // 메시지가 제목과 링크뿐이라, 제목에 없는 회사로 알림이 나가면 설명이 안 된다.
  //
  // squash 하지 않는 이유는 공백을 지우면 단어 경계를 넘어 없던 회사명이 만들어지기
  // 때문이다 — "삼성 전자제품" → "삼성전자제품" 은 "삼성전자" 를 포함하고,
  // "현대 차량" 은 "현대차" 를 포함한다. 종목명은 표현 변형이 거의 없어 얻을 것도 없다.
  //
  // 매크로 트랙(3c)이 붙기 전까지 여기서 막힌 것은 전부 drop 이지만, events 에는
  // 그대로 기록되어 3c·3d 튜닝 근거가 된다.
  const corp = matchCorp(event.title, index)
  if (!corp) return { action: 'drop', reason: 'no-corp-match' }

  // 게이트 2 — 영향 키워드. 이쪽은 squash 한다. 뉴스 제목이 자유 형식이라
  // `계약 체결` 과 `계약체결` 을 같게 봐야 한다.
  const titleSq = squash(event.title)
  const fullSq = squash(`${event.title} ${description}`)
  for (const { tier, words } of NEWS_TIERS) {
    // critical 만 제목으로 한정한다. 실측 최악의 오탐이 이 티어였다 — "맥쿼리 가비아
    // 공개매수 무산" 이 본문의 '상장폐지' 때문에 critical 로 나갔다. critical 은 병합을
    // 건너뛰고 즉시 발송되므로 틀렸을 때 가장 비싸다. high/normal 은 본문을 쓴다 —
    // 제목만으로는 "3분기 실적 발표" 가 호실적인지 어닝쇼크인지 알 수 없다.
    const haystack = tier === 'critical' ? titleSq : fullSq
    const hit = words.find((w) => haystack.includes(squash(w)))
    if (hit) return { action: 'pass', tier, rule: `keyword:${hit}` }
  }

  return { action: 'drop', reason: 'no-keyword-match' }
}
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/core/news/rules.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: 커밋**

```bash
git add apps/worker/src/core/news/
git commit -m "feat(news): 뉴스 룰 엔진 — 종목 연결 후 영향 키워드

DART 키워드셋과 사건 종류는 같지만 표기가 다르다. DART 는
단일판매ㆍ공급계약체결 같은 정형 제목이고 뉴스는 수주 / 계약 체결 /
공급 계약 으로 흩어져, 공백을 지우고 매칭해 변형을 흡수한다.

description 은 판정에만 쓰고 반환하지 않는다 — 저작권상 저장·발송이
안 되지만, 제목만으로는 '삼성전자 3분기 실적 발표'가 호실적인지
어닝쇼크인지 알 수 없어 정확도가 크게 떨어진다."
```

---

### Task 4: 상장사 명부 로더 (어댑터)

**Files:**
- Create: `apps/worker/src/adapters/sources/corp-code.ts`
- Test: `apps/worker/src/adapters/sources/corp-code.test.ts`
- Modify: `apps/worker/package.json` (의존성 `fflate` 추가)

**Interfaces:**
- Consumes: Task 2 의 `CorpEntry`
- Produces: `fetchCorpEntries(apiKey: string, fetchImpl?: typeof fetch): Promise<CorpEntry[]>`

**Why:** Task 2 의 인덱스에 넣을 실제 상장사 목록이 필요하다. DART `corpCode.xml` 이 전체 기업 고유번호를 주며 `stock_code` 가 있는 항목이 상장사다. 응답이 ZIP 이라 해제가 필요하다.

**등록명만으로는 부족하다 — 별칭이 필요하다.** DART 는 법인 등기명을 주는데 뉴스는 통용명을 쓴다. 주요 42개 종목으로 실측한 결과 6개가 매칭되지 않았다:

| 뉴스 표기 | DART 등록명 | 지금 결과 |
|---|---|---|
| 현대차 | 현대자동차 | 매칭 없음 |
| 네이버 | NAVER | 매칭 없음 |
| KT | 케이티 | 매칭 없음 |
| 삼성화재 | 삼성화재해상보험 | 매칭 없음 |
| 에쓰오일 | S-Oil | 매칭 없음 |
| **한국전력** | 한국전력공사 | **`국전` 으로 오귀속** |

마지막 줄이 가장 나쁘다. `한국전력` 이 `국전`(별개 상장사)을 포함해, 한국전력 기사가 무관한 소형주 알림으로 나간다. Task 3 에서 고친 한섬→현대백화점 오귀속과 같은 부류인데 회사가 아예 무관하다는 점이 더 나쁘다.

별칭을 넣으면 두 문제가 같이 풀린다 — `한국전력`(4자)이 `국전`(2자)보다 길어 긴 이름 우선 규칙이 먼저 잡는다.

목록은 짧다. 주요 42개 중 6개였으므로 알고리즘이 아니라 **손으로 관리하는 목록**으로 간다. 3a 운영 데이터의 `no-corp-match` 를 보고 늘린다.

- [ ] **Step 1: 의존성을 추가한다**

```bash
cd apps/worker && pnpm add fflate
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

```ts
import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { fetchCorpEntries } from './corp-code.js'

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<result>
  <list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name>
        <stock_code>005930</stock_code><modify_date>20260101</modify_date></list>
  <list><corp_code>00111111</corp_code><corp_name>비상장회사</corp_name>
        <stock_code> </stock_code><modify_date>20260101</modify_date></list>
  <list><corp_code>00222222</corp_code><corp_name>한미약품</corp_name>
        <stock_code>128940</stock_code><modify_date>20260101</modify_date></list>
</result>`

function zipped(): ArrayBuffer {
  const z = zipSync({ 'CORPCODE.xml': strToU8(XML) })
  return z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength) as ArrayBuffer
}

const okFetch = (async () =>
  new Response(zipped(), { status: 200 })) as unknown as typeof fetch

describe('fetchCorpEntries', () => {
  it('stock_code가 있는 상장사만 돌려준다', async () => {
    const entries = await fetchCorpEntries('k'.repeat(40), okFetch)
    expect(entries).toEqual([
      { name: '삼성전자', ticker: '005930' },
      { name: '한미약품', ticker: '128940' },
    ])
  })

  it('HTTP 오류는 던진다 — 빈 명부로 조용히 도는 것이 최악이다', async () => {
    const bad = (async () => new Response('', { status: 500 })) as unknown as typeof fetch
    await expect(fetchCorpEntries('k'.repeat(40), bad)).rejects.toThrow(/500/)
  })

  it('상장사가 한 곳도 없으면 던진다', async () => {
    const empty = `<result><list><corp_code>1</corp_code><corp_name>A</corp_name>
      <stock_code> </stock_code><modify_date>1</modify_date></list></result>`
    const z = zipSync({ 'CORPCODE.xml': strToU8(empty) })
    const buf = z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength) as ArrayBuffer
    const f = (async () => new Response(buf, { status: 200 })) as unknown as typeof fetch
    await expect(fetchCorpEntries('k'.repeat(40), f)).rejects.toThrow(/상장사/)
  })
})
```

- [ ] **Step 3: 테스트가 실패하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/adapters/sources/corp-code.test.ts`
Expected: FAIL — `Cannot find module './corp-code.js'`

- [ ] **Step 4: `core/news/corp-index.ts` 에 별칭 목록을 추가한다**

순수 데이터이므로 `core/` 에 둔다. 적용은 어댑터가 한다.

```ts
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
 */
export const CORP_ALIASES: ReadonlyArray<{ alias: string; ticker: string }> = [
  { alias: '현대차', ticker: '005380' },
  { alias: '네이버', ticker: '035420' },
  { alias: 'KT', ticker: '030200' },
  { alias: '삼성화재', ticker: '000810' },
  { alias: '에쓰오일', ticker: '010950' },
  { alias: '한국전력', ticker: '015760' },
]
```

- [ ] **Step 5: 구현을 쓴다**

```ts
import { unzipSync, strFromU8 } from 'fflate'
import { CORP_ALIASES, type CorpEntry } from '../../core/news/corp-index.js'

const ENDPOINT = 'https://opendart.fss.or.kr/api/corpCode.xml'

/** 명부는 하루 한 번 받으면 되므로 목록 API보다 넉넉히 준다 — 응답이 수 MB다. */
const REQUEST_TIMEOUT_MS = 30_000

const LIST_RE = /<list>([\s\S]*?)<\/list>/g

function field(block: string, name: string): string {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)
  return (m?.[1] ?? '').trim()
}

/**
 * DART 전체 기업 고유번호에서 상장사만 추린다. `stock_code` 가 공백이면 비상장이다.
 *
 * 실패 시 반드시 던진다. 빈 명부로 조용히 도는 것이 최악의 실패다 — 모든 뉴스가
 * `no-corp-match` 로 drop 되면서 워커는 정상으로 보이고 알림만 0건이 된다.
 * 이 프로젝트에서 반복된 실패 유형(재보지 않은 부재를 보고하기)과 같은 것이다.
 */
export async function fetchCorpEntries(
  apiKey: string, fetchImpl?: typeof fetch,
): Promise<CorpEntry[]> {
  const doFetch = fetchImpl ?? fetch
  const url = new URL(ENDPOINT)
  url.searchParams.set('crtfc_key', apiKey)

  const res = await doFetch(url.toString(), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`corpCode HTTP ${res.status}`)

  const files = unzipSync(new Uint8Array(await res.arrayBuffer()))
  const name = Object.keys(files).find((f) => f.toUpperCase().endsWith('.XML'))
  if (!name) throw new Error('corpCode ZIP 안에 XML이 없다')

  const xml = strFromU8(files[name]!)
  const out: CorpEntry[] = []
  for (const m of xml.matchAll(LIST_RE)) {
    const ticker = field(m[1]!, 'stock_code')
    const corpName = field(m[1]!, 'corp_name')
    if (ticker && corpName) out.push({ name: corpName, ticker })
  }

  if (out.length === 0) throw new Error('corpCode 응답에 상장사가 한 곳도 없다')

  // 별칭을 붙인다. 티커가 명부에 실제로 있는 것만 — 상장폐지된 티커의 별칭을
  // 남겨두면 그 이름이 영원히 잘못된 회사로 잡힌다.
  const tickers = new Set(out.map((e) => e.ticker))
  for (const a of CORP_ALIASES) {
    if (tickers.has(a.ticker)) out.push({ name: a.alias, ticker: a.ticker })
  }

  return out
}
```

- [ ] **Step 6: 별칭 테스트를 추가한다**

```ts
it('별칭을 명부에 더한다', async () => {
  const xml = `<result>
    <list><corp_code>1</corp_code><corp_name>현대자동차</corp_name>
          <stock_code>005380</stock_code><modify_date>1</modify_date></list>
  </result>`
  const z = zipSync({ 'CORPCODE.xml': strToU8(xml) })
  const buf = z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength) as ArrayBuffer
  const f = (async () => new Response(buf, { status: 200 })) as unknown as typeof fetch
  const entries = await fetchCorpEntries('k'.repeat(40), f)
  expect(entries).toContainEqual({ name: '현대자동차', ticker: '005380' })
  expect(entries).toContainEqual({ name: '현대차', ticker: '005380' })
})

it('명부에 없는 티커의 별칭은 넣지 않는다 — 상장폐지 종목이 영원히 잘못 잡힌다', async () => {
  const xml = `<result>
    <list><corp_code>1</corp_code><corp_name>삼성전자</corp_name>
          <stock_code>005930</stock_code><modify_date>1</modify_date></list>
  </result>`
  const z = zipSync({ 'CORPCODE.xml': strToU8(xml) })
  const buf = z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength) as ArrayBuffer
  const f = (async () => new Response(buf, { status: 200 })) as unknown as typeof fetch
  const entries = await fetchCorpEntries('k'.repeat(40), f)
  expect(entries.map((e) => e.name)).not.toContain('현대차')
})
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/adapters/sources/corp-code.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: 커밋**

```bash
git add apps/worker/src/adapters/sources/corp-code.ts \
        apps/worker/src/adapters/sources/corp-code.test.ts \
        apps/worker/package.json ../../pnpm-lock.yaml
git commit -m "feat(news): DART corpCode 로 상장사 명부를 받는다

응답이 ZIP 이라 fflate(순수 JS, 네이티브 없음)로 해제한다.
stock_code 가 공백이면 비상장이므로 거른다.

실패 시 반드시 던진다. 빈 명부로 조용히 도는 것이 최악의 실패다 —
모든 뉴스가 no-corp-match 로 drop 되면서 워커는 정상으로 보이고
알림만 0건이 된다."
```

---

### Task 5: RSS 소스 어댑터

**Files:**
- Create: `apps/worker/src/adapters/sources/rss.ts`
- Test: `apps/worker/src/adapters/sources/rss.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `parseRssFeed`, `RssItem`
- Produces: `type FeedConfig = { id: string; press: string; url: string }`, `createRssSource(cfg: RssSourceConfig): EventSource & { descriptionOf(externalId: string): string }`, `FEEDS: readonly FeedConfig[]`

**Why:** 스펙 §4.2·§4.3. 조건부 요청으로 304 를 받아 대역폭을 아끼고, `raw` 를 축소해 저장하며, `description` 은 판정용으로만 곁에 남긴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
import { describe, it, expect, vi } from 'vitest'
import { createRssSource } from './rss.js'

const FEED = (title: string, link: string) => `<rss><channel><item>
  <title>${title}</title><link>${link}</link><guid>${link}</guid>
  <description>본문 일부</description>
  <pubDate>Sun, 20 Sep 2026 18:05:00 +0900</pubDate>
</item></channel></rss>`

const NOW = new Date('2026-09-20T09:10:00Z')

describe('createRssSource', () => {
  it('여러 피드를 하나의 이벤트 목록으로 합친다', async () => {
    const f = vi.fn(async (u: string) =>
      new Response(FEED(`제목 ${u.slice(-1)}`, `https://x/${u.slice(-1)}`), { status: 200 }))
    const src = createRssSource({
      feeds: [
        { id: 'a', press: '연합', url: 'https://f/a' },
        { id: 'b', press: '이데일리', url: 'https://f/b' },
      ],
      fetchImpl: f as unknown as typeof fetch,
    })
    const out = await src.fetchLatest(NOW)
    expect(out).toHaveLength(2)
    expect(out.map((e) => e.sourceId)).toEqual(['news', 'news'])
  })

  it('두 번째 호출에 If-None-Match를 붙이고 304면 건너뛴다', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(FEED('제목', 'https://x/1'),
        { status: 200, headers: { etag: 'W/"v1"' } }))
      .mockResolvedValueOnce(new Response('', { status: 304 }))
    const src = createRssSource({
      feeds: [{ id: 'a', press: '연합', url: 'https://f/a' }],
      fetchImpl: f as unknown as typeof fetch,
    })
    expect(await src.fetchLatest(NOW)).toHaveLength(1)
    expect(await src.fetchLatest(NOW)).toHaveLength(0)
    expect((f.mock.calls[1]![1] as RequestInit).headers)
      .toMatchObject({ 'If-None-Match': 'W/"v1"' })
  })

  it('한 피드가 실패해도 나머지는 살린다', async () => {
    const f = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(new Response(FEED('살아남은 기사', 'https://x/2'), { status: 200 }))
    const src = createRssSource({
      feeds: [
        { id: 'a', press: '연합', url: 'https://f/a' },
        { id: 'b', press: '이데일리', url: 'https://f/b' },
      ],
      fetchImpl: f as unknown as typeof fetch,
    })
    const out = await src.fetchLatest(NOW)
    expect(out).toHaveLength(1)
    expect(out[0]!.title).toBe('살아남은 기사')
  })

  it('raw에 description을 담지 않는다 — 저작권', async () => {
    const f = vi.fn(async () => new Response(FEED('제목', 'https://x/1'), { status: 200 }))
    const src = createRssSource({
      feeds: [{ id: 'a', press: '연합', url: 'https://f/a' }],
      fetchImpl: f as unknown as typeof fetch,
    })
    const [e] = await src.fetchLatest(NOW)
    expect(JSON.stringify(e!.raw)).not.toContain('본문 일부')
    expect(e!.raw).toMatchObject({ press: '연합' })
  })

  it('firstSeenAt은 now, occurredAt은 pubDate다', async () => {
    const f = vi.fn(async () => new Response(FEED('제목', 'https://x/1'), { status: 200 }))
    const src = createRssSource({
      feeds: [{ id: 'a', press: '연합', url: 'https://f/a' }],
      fetchImpl: f as unknown as typeof fetch,
    })
    const [e] = await src.fetchLatest(NOW)
    expect(e!.firstSeenAt).toEqual(NOW)
    expect(e!.occurredAt?.toISOString()).toBe('2026-09-20T09:05:00.000Z')
  })

  it('description은 판정용으로 곁에 남긴다', async () => {
    const f = vi.fn(async () => new Response(FEED('제목', 'https://x/1'), { status: 200 }))
    const src = createRssSource({
      feeds: [{ id: 'a', press: '연합', url: 'https://f/a' }],
      fetchImpl: f as unknown as typeof fetch,
    })
    const [e] = await src.fetchLatest(NOW)
    expect(src.descriptionOf(e!.externalId)).toBe('본문 일부')
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/adapters/sources/rss.test.ts`
Expected: FAIL — `Cannot find module './rss.js'`

- [ ] **Step 3: 구현을 쓴다**

```ts
import type { NormalizedEvent } from '@app/shared'
import type { EventSource } from '../../ports/source.js'
import { parseRssFeed } from '../../core/news/rss.js'

const REQUEST_TIMEOUT_MS = 10_000

export type FeedConfig = {
  /** 내부 식별자. externalId 접두어로 쓴다. */
  id: string
  /** 발송 메시지에 표시할 매체명. */
  press: string
  url: string
}

/**
 * 실측(스펙 §4.2)으로 살아 있음을 확인한 피드들. **확인은 Node 의 기본 TLS 설정으로
 * 했다** — curl 이나 검증을 끈 클라이언트로 되는 것이 워커에서 된다는 보장이 없다.
 * 조건부 요청 지원 여부가 폴링 주기를 가른다 — 미지원 매체를 짧게 폴링하면 매번
 * 전문을 받는다.
 */
export const FEEDS: readonly FeedConfig[] = [
  { id: 'yna-market', press: '연합뉴스', url: 'https://www.yna.co.kr/rss/market.xml' },
  { id: 'mt', press: '머니투데이', url: 'https://rss.mt.co.kr/mt_news.xml' },
  { id: 'hk-fin', press: '한국경제', url: 'https://www.hankyung.com/feed/finance' },
  { id: 'chosunbiz', press: '조선비즈', url: 'https://biz.chosun.com/arc/outboundfeeds/rss/category/stock/?outputType=xml' },
  { id: 'mk-stock', press: '매일경제', url: 'https://www.mk.co.kr/rss/50200011/' },
]

// 이데일리는 넣지 않는다. rss.edaily.co.kr 이 TLS 1.0 으로만 협상하는데 Node 의
// 기본 최소 버전은 TLS 1.2 라 ERR_SSL_UNSUPPORTED_PROTOCOL 로 실패한다. 피드 하나를
// 얻자고 워커 전체의 TLS 바닥을 폐기된 프로토콜(RFC 8996)까지 내리지 않는다. 스펙 §4.2.

export type RssSourceConfig = {
  feeds: readonly FeedConfig[]
  fetchImpl?: typeof fetch
  /** 한 피드가 죽어도 루프는 살아야 한다. 기본은 무시하고 로그만. */
  onFeedError?: (feedId: string, err: unknown) => void
}

export type RssSource = EventSource & {
  /**
   * 판정에만 쓰는 원문 요약. 저장·발송하지 않으므로 NormalizedEvent 에 담지 않고
   * 마지막 fetch 분만 여기 남긴다 (스펙 §4.3, 저작권).
   */
  descriptionOf(externalId: string): string
}

export function createRssSource(cfg: RssSourceConfig): RssSource {
  const doFetch = cfg.fetchImpl ?? fetch
  const validators = new Map<string, { etag?: string; lastModified?: string }>()
  let descriptions = new Map<string, string>()

  return {
    id: 'news',

    descriptionOf: (externalId: string) => descriptions.get(externalId) ?? '',

    async fetchLatest(now: Date): Promise<NormalizedEvent[]> {
      const out: NormalizedEvent[] = []
      const nextDescriptions = new Map<string, string>()

      for (const feed of cfg.feeds) {
        try {
          const v = validators.get(feed.id)
          const headers: Record<string, string> = { 'User-Agent': 'market-radar/1.0' }
          if (v?.etag) headers['If-None-Match'] = v.etag
          if (v?.lastModified) headers['If-Modified-Since'] = v.lastModified

          const res = await doFetch(feed.url, {
            headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          })
          // 바뀐 게 없다 — 본문을 받지 않고 넘어간다.
          if (res.status === 304) continue
          if (!res.ok) throw new Error(`RSS HTTP ${res.status}`)

          const etag = res.headers.get('etag') ?? undefined
          const lastModified = res.headers.get('last-modified') ?? undefined
          if (etag || lastModified) validators.set(feed.id, { etag, lastModified })

          for (const item of parseRssFeed(await res.text())) {
            const externalId = `${feed.id}:${item.guid}`
            nextDescriptions.set(externalId, item.description)
            out.push({
              sourceId: 'news',
              externalId,
              // pubDate 는 신뢰하지 않는다(매일경제가 미래 시각을 준다) —
              // 기록만 하고 발송 판단은 firstSeenAt 으로 한다. 스펙 §4.3.
              occurredAt: item.pubDate,
              firstSeenAt: now,
              title: item.title,
              url: item.link,
              // raw 는 축소한다. description 을 넣지 않는 것은 저작권 때문이고,
              // 크기를 줄이는 것은 무료 티어 500MB 때문이다. 스펙 §6.2.
              raw: { feedId: feed.id, press: feed.press, pubDate: item.pubDate?.toISOString() ?? null },
            })
          }
        } catch (err) {
          // 한 매체의 장애가 나머지 매체를 막으면 안 된다.
          cfg.onFeedError?.(feed.id, err)
        }
      }

      descriptions = nextDescriptions
      return out
    },
  }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/adapters/sources/rss.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add apps/worker/src/adapters/sources/rss.ts apps/worker/src/adapters/sources/rss.test.ts
git commit -m "feat(news): RSS 소스 어댑터 — 조건부 요청, raw 축소

ETag/Last-Modified 로 304 를 받아 본문 수신을 건너뛴다.

raw 에 description 을 넣지 않는다. 저작권 때문이고, 크기를 줄이는
것은 무료 티어 500MB 때문이다(스펙 §6.2). 판정에는 필요하므로
descriptionOf 로 마지막 fetch 분만 곁에 남긴다.

한 피드가 죽어도 나머지는 살린다 — 매체 하나의 장애가 전체 수집을
멈추면 안 된다."
```

---

### Task 6: 다중 소스 사이클

**Files:**
- Modify: `apps/worker/src/pipeline/ingest.ts`, `apps/worker/src/pipeline/cycle.ts`
- Test: `apps/worker/src/pipeline/ingest.test.ts`, `apps/worker/src/pipeline/cycle.test.ts`

**Interfaces:**
- Consumes: Task 3 의 `evaluateNews`, Task 5 의 `RssSource`
- Produces: `type SourcePlan = { source: EventSource; evaluate: (e: NormalizedEvent) => Verdict; intervalMs(now: Date): number; countsAgainstApiBudget: boolean }`, `runIngest(deps: { plan: SourcePlan; store: EventStore }, state: IngestState, now: Date)`

**Why:** `runCycle` 이 `deps.source` 단수를 전제로 짜여 있고 `seen` 도 하나뿐이다. 소스마다 폴링 주기(DART 10초 / RSS 30초~3분), 예산(DART 만 한도 추적), 판정 함수가 다르므로 하나로 묶어 전달한다. **이 프로젝트에서 가장 민감한 코드이므로 기존 테스트가 전부 통과해야 한다.**

- [ ] **Step 1: `runIngest` 가 판정 함수를 주입받도록 테스트를 고친다**

`apps/worker/src/pipeline/ingest.test.ts` 의 모든 `runIngest({ source, store }, …)` 호출을 아래 형태로 바꾼다. 기존 기대값(콜드 스타트 억제, seen-set, 중복 처리)은 **한 줄도 바꾸지 않는다.**

```ts
import { evaluateDart } from '../core/dart/rules.js'

const plan = { source, evaluate: evaluateDart, intervalMs: () => 10_000, countsAgainstApiBudget: true }
const r = await runIngest({ plan, store }, state, now)
```

추가로 아래 테스트를 새로 넣는다.

```ts
it('판정 함수를 주입받는다 — 소스마다 룰이 다르다', async () => {
  const { store, recordEvent } = fakeStore()
  const source = fakeSource([
    { sourceId: 'news', externalId: 'n1', occurredAt: null, firstSeenAt: new Date(),
      title: '아무 제목', url: 'https://x/1', raw: {} },
  ])
  const alwaysPass = () => ({ action: 'pass', tier: 'high', rule: 'test' }) as const
  await runIngest(
    { plan: { source, evaluate: alwaysPass, intervalMs: () => 30_000, countsAgainstApiBudget: false }, store },
    { seen: createSeenSet([]), coldStart: false },
    new Date(),
  )
  expect(recordEvent).toHaveBeenCalledWith(
    expect.objectContaining({ externalId: 'n1' }),
    { action: 'pass', tier: 'high', rule: 'test' },
    expect.objectContaining({ enqueue: true }),
  )
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/pipeline/ingest.test.ts`
Expected: FAIL — `plan` 을 읽지 못한다

- [ ] **Step 3: `ingest.ts` 를 고친다**

`evaluateDart` import 를 지우고 시그니처만 바꾼다. **루프 본문의 게이트 8 주석과 seen-set 로직은 그대로 둔다.**

```ts
import type { NormalizedEvent, Verdict } from '@app/shared'
import type { EventSource } from '../ports/source.js'
import type { EventStore } from '../ports/store.js'
import type { SeenSet } from '../core/seen.js'
import { expiresAt } from '../core/policy.js'

/**
 * 하나의 소스와 그 소스를 다루는 방법을 묶는다. 소스마다 폴링 주기·예산·판정이
 * 다르므로 `EventSource` 만으로는 부족하다.
 */
export type SourcePlan = {
  source: EventSource
  /** 이 소스의 판정 함수. DART 는 evaluateDart, 뉴스는 evaluateNews 를 감싼 것. */
  evaluate: (event: NormalizedEvent) => Verdict
  /** 이 소스를 얼마나 자주 볼 것인가. 시각별로 달라질 수 있다. */
  intervalMs(now: Date): number
  /**
   * DART 처럼 일일 호출 한도가 있는 소스만 true. RSS 는 한도가 없으므로 false 이고,
   * api_usage 를 올리지 않는다 — 올리면 DART 예산 가드가 엉뚱하게 발동한다.
   */
  countsAgainstApiBudget: boolean
}

export type IngestDeps = { plan: SourcePlan; store: EventStore }
```

`runIngest` 본문에서 두 줄만 바꾼다.

```ts
  const events = await deps.plan.source.fetchLatest(now)
  // …
    const verdict: Verdict = deps.plan.evaluate(event)
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/pipeline/ingest.test.ts`
Expected: PASS — 기존 테스트 전부 + 새 테스트 1건

- [ ] **Step 5: `cycle.ts` 를 다중 소스로 고치는 테스트를 쓴다**

```ts
it('주기가 아직 안 된 소스는 건너뛴다', async () => {
  const fast = fakePlan('dart', 10_000)
  const slow = fakePlan('news', 60_000)
  const deps = depsWith([fast, slow])
  let state = initialState([fast, slow])

  state = await runCycle(deps, state, new Date('2026-09-21T01:00:00Z'))
  expect(fast.source.fetchLatest).toHaveBeenCalledTimes(1)
  expect(slow.source.fetchLatest).toHaveBeenCalledTimes(1)

  // 10초 뒤 — 빠른 소스만 다시 본다
  state = await runCycle(deps, state, new Date('2026-09-21T01:00:10Z'))
  expect(fast.source.fetchLatest).toHaveBeenCalledTimes(2)
  expect(slow.source.fetchLatest).toHaveBeenCalledTimes(1)
})

it('api_usage는 예산이 있는 소스만 올린다', async () => {
  const dart = fakePlan('dart', 10_000, true)
  const news = fakePlan('news', 10_000, false)
  const deps = depsWith([dart, news])
  await runCycle(deps, initialState([dart, news]), new Date('2026-09-21T01:00:00Z'))
  expect(deps.store.incrementApiUsage).toHaveBeenCalledTimes(1)
  expect(deps.store.incrementApiUsage).toHaveBeenCalledWith('dart', expect.any(String))
})

it('한 소스가 던져도 다른 소스는 처리된다', async () => {
  const bad = fakePlan('dart', 10_000)
  bad.source.fetchLatest = vi.fn().mockRejectedValue(new Error('DART down'))
  const good = fakePlan('news', 10_000)
  const deps = depsWith([bad, good])
  await runCycle(deps, initialState([bad, good]), new Date('2026-09-21T01:00:00Z'))
  expect(good.source.fetchLatest).toHaveBeenCalledTimes(1)
})

it('seen-set은 소스마다 따로다 — externalId가 충돌할 수 있다', async () => {
  const a = fakePlan('dart', 10_000)
  const b = fakePlan('news', 10_000)
  const deps = depsWith([a, b])
  const state = await runCycle(deps, initialState([a, b]), new Date('2026-09-21T01:00:00Z'))
  expect(state.seen.get('dart')).not.toBe(state.seen.get('news'))
})
```

- [ ] **Step 6: 테스트가 실패하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/pipeline/cycle.test.ts`
Expected: FAIL

- [ ] **Step 7: `cycle.ts` 를 고친다**

`CycleDeps.source` 를 `plans: readonly SourcePlan[]` 으로 바꾸고, `IngestState` 를 소스별로 나눈다.

```ts
export type CycleDeps = {
  plans: readonly SourcePlan[]
  store: EventStore
  // …나머지 필드는 그대로…
}

export type CycleState = {
  lastDigestDate: string
  digestAttempt: DigestAttempt | null
  heartbeatFailures: number
  /** 소스마다 따로 둔다 — externalId 는 소스 안에서만 유일하다. */
  seen: Map<string, SeenSet>
  /** 소스마다 따로 둔다 — 새로 붙인 소스만 콜드 스타트일 수 있다. */
  coldStart: Map<string, boolean>
  /** 소스별 다음 실행 시각(ms). 주기가 서로 다르다. */
  nextRunAt: Map<string, number>
}
```

`runCycle` 의 `try` 블록에서 소스를 순회한다. **소스 하나의 실패가 나머지를 막지 않도록 각 소스를 개별 try 로 감싼다** — 기존의 바깥 try/catch(서킷 브레이커·하트비트)는 그대로 둔다.

```ts
    for (const plan of deps.plans) {
      const id = plan.source.id
      if ((state.nextRunAt.get(id) ?? 0) > now.getTime()) continue
      nextRunAt.set(id, now.getTime() + plan.intervalMs(now))

      try {
        // 한도가 있는 소스만 센다. RSS 를 세면 DART 예산 가드가 엉뚱하게 발동한다.
        if (plan.countsAgainstApiBudget) {
          used = await deps.store.incrementApiUsage(id, kstDate)
        }
        const ingest = await runIngest(
          { plan, store: deps.store },
          { seen: seen.get(id)!, coldStart: coldStart.get(id) ?? true },
          now,
        )
        seen.set(id, ingest.state.seen)
        coldStart.set(id, ingest.state.coldStart)
        // …콜드 스타트 로그와 사이클 로그는 기존 그대로, sourceId 만 덧붙인다…
      } catch (err) {
        // 한 소스의 장애가 다른 소스의 수집을 막으면 안 된다. 서킷 브레이커는
        // 바깥 catch 가 담당하므로 여기서는 기록만 한다.
        deps.log.error({ err, sourceId: id }, 'source ingest failed')
        anySourceFailed = true
      }
    }
    if (anySourceFailed) throw new Error('one or more sources failed')
```

`sleepMs` 는 **다음에 깨어나야 할 가장 이른 시각**으로 정한다.

```ts
    const soonest = Math.min(...[...nextRunAt.values()].map((t) => t - now.getTime()))
    sleepMs = budgetGuard(used, Math.max(soonest, 1_000), deps.dailyLimit)
```

`catchUpDigests` 의 `sourceId` 는 `'dart'` 로 고정해 기존 다이제스트 동작을 유지한다 (뉴스 다이제스트는 3c 에서 붙인다).

- [ ] **Step 8: 전체 테스트를 돌린다**

Run: `cd apps/worker && npx vitest run && npx tsc --noEmit`
Expected: 기존 테스트 전부 통과 + 새 테스트 통과

- [ ] **Step 9: 커밋**

```bash
git add apps/worker/src/pipeline/
git commit -m "refactor(worker): 사이클을 다중 소스로 일반화

runCycle 이 deps.source 단수를 전제로 짜여 있었다. 소스마다 폴링
주기(DART 10초 / RSS 30초~3분), 예산(DART 만 한도 추적), 판정 함수가
달라 SourcePlan 으로 묶어 넘긴다.

seen-set 과 coldStart 를 소스별 Map 으로 나눴다. externalId 는 소스
안에서만 유일해 한 집합에 섞으면 충돌한다.

api_usage 는 countsAgainstApiBudget 인 소스만 올린다. RSS 를 세면
DART 예산 가드가 엉뚱하게 발동해 폴링이 5배로 늘어진다.

소스별 개별 try 를 둬 한 소스의 장애가 나머지 수집을 막지 않게 했다.
서킷 브레이커와 하트비트는 바깥 try/catch 그대로다."
```

---

### Task 7: 뉴스 메시지 포맷

**Files:**
- Modify: `apps/worker/src/core/format.ts`
- Test: `apps/worker/src/core/format.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent`, `Tier`
- Produces: `formatNewsEvent(e: NormalizedEvent, tier: Tier): string`, `formatNewsMerged(items: ReadonlyArray<{ event: NormalizedEvent; tier: Tier }>): string`

**Why:** 스펙 §7. 제목 + 링크 + 매체만 나가고 `description` 원문·영향 판정·업종 해석은 나가지 않는다.

**병합 경로가 따로 필요하다.** 기존 `formatMerged` 는 `subjectLine(event)` 를 쓰는데 그것이 `e.subject?.name` 을 읽는다 — 뉴스 이벤트에는 `subject` 가 없으므로 병합 메시지에 `*undefined*` 가 찍힌다. 헤더도 `📢 공시 N건` 으로 하드코딩돼 있어 뉴스가 "공시"로 나간다. 기존 `formatMerged` 와 그 테스트는 **건드리지 않고** 뉴스용을 따로 만든 뒤, Task 8 에서 dispatch 가 소스별로 나눠 묶게 한다 — 병합은 레이트리밋 압박을 줄이려는 것이므로 뉴스에서도 살아 있어야 한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
import { formatNewsEvent } from './format.js'

const newsEvent = (title: string): NormalizedEvent => ({
  sourceId: 'news', externalId: 'yna-eco:1', occurredAt: new Date('2026-09-20T09:05:00Z'),
  firstSeenAt: new Date('2026-09-20T09:10:00Z'), title,
  url: 'https://example.com/a', raw: { feedId: 'yna-eco', press: '연합뉴스' },
})

describe('formatNewsEvent', () => {
  it('제목·매체·링크를 담는다', () => {
    const s = formatNewsEvent(newsEvent('한미약품 수주 계약'), 'high')
    expect(s).toContain('한미약품 수주 계약')
    expect(s).toContain('연합뉴스')
    expect(s).toContain('https://example.com/a')
  })

  it('면책 문구를 붙인다', () => {
    expect(formatNewsEvent(newsEvent('제목'), 'high')).toContain(DISCLAIMER)
  })

  it('MarkdownV2 특수문자를 이스케이프한다', () => {
    const s = formatNewsEvent(newsEvent('한미약품 (주) 수주 - 1분기'), 'high')
    expect(s).toContain('\\(')
    expect(s).toContain('\\-')
  })

  it('press가 없으면 매체 줄을 생략한다 — 빈 라벨을 찍지 않는다', () => {
    const e = { ...newsEvent('제목'), raw: {} }
    expect(formatNewsEvent(e, 'high')).not.toContain('출처')
  })

  it('subject가 없어도 undefined가 새지 않는다', () => {
    expect(formatNewsEvent(newsEvent('제목'), 'high')).not.toContain('undefined')
  })
})

describe('formatNewsMerged', () => {
  it('헤더가 공시가 아니라 뉴스다', () => {
    const s = formatNewsMerged([{ event: newsEvent('가'), tier: 'high' }])
    expect(s).toContain('뉴스 1건')
    expect(s).not.toContain('공시')
  })

  it('subject가 없어도 undefined가 새지 않는다 — formatMerged 를 그대로 쓰면 터지는 지점', () => {
    const s = formatNewsMerged([
      { event: newsEvent('가'), tier: 'high' },
      { event: newsEvent('나'), tier: 'normal' },
    ])
    expect(s).not.toContain('undefined')
    expect(s).toContain('연합뉴스')
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/core/format.test.ts`
Expected: FAIL — `formatNewsEvent is not a function`

- [ ] **Step 3: 구현을 쓴다**

기존 `formatEvent` 옆에 추가한다.

```ts
const TIER_MARK: Record<Tier, string> = { critical: '🔴', high: '🟠', normal: '🔵' }

/**
 * 뉴스 알림 포맷. 제목·매체·링크만 담는다.
 *
 * 담지 않는 것들이 중요하다 — RSS `description` 원문은 저작권상 재배포할 수 없고,
 * 영향 판정(어느 종목·업종에 어떻게)은 유사투자자문에 해당한다. tier 는 고르는 데만
 * 쓰고 방향(호재/악재)을 뜻하지 않는다. 스펙 §7.
 */
export function formatNewsEvent(e: NormalizedEvent, tier: Tier): string {
  const raw = e.raw as { press?: string } | null
  const press = typeof raw?.press === 'string' ? raw.press : null
  const lines = [
    `${TIER_MARK[tier]} *뉴스*`,
    escapeMarkdownV2(e.title),
  ]
  if (press) lines.push(`출처: ${escapeMarkdownV2(press)}`)
  lines.push(escapeMarkdownV2(e.url), '', DISCLAIMER)
  return lines.join('\n')
}

/** 뉴스 병합. formatMerged 를 쓰면 subjectLine 이 subject 없는 뉴스에서 undefined 를 찍는다. */
export function formatNewsMerged(
  items: ReadonlyArray<{ event: NormalizedEvent; tier: Tier }>,
): string {
  const head = `📰 뉴스 ${items.length}건`
  const body = items.map(({ event, tier }) => {
    const raw = event.raw as { press?: string } | null
    const press = typeof raw?.press === 'string' ? `[${escapeMarkdownV2(raw.press)}] ` : ''
    return `${TIER_MARK[tier]} ${press}${escapeMarkdownV2(event.title)}\n${escapeMarkdownV2(event.url)}`
  })
  return [head, '', ...body, '', DISCLAIMER].join('\n')
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/core/format.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add apps/worker/src/core/format.ts apps/worker/src/core/format.test.ts
git commit -m "feat(news): 뉴스 메시지 포맷 — 제목·매체·링크만

담지 않는 것이 중요하다. description 원문은 저작권상 재배포할 수
없고, 영향 판정(어느 종목·업종에 어떻게)은 유사투자자문이다.
tier 는 고르는 데만 쓰고 방향을 뜻하지 않는다."
```

---

### Task 8: 배선 (config + main)

**Files:**
- Modify: `apps/worker/src/config.ts`, `apps/worker/src/main.ts`, `apps/worker/src/pipeline/dispatch.ts`, `.env.example`
- Test: `apps/worker/src/config.test.ts`

**Interfaces:**
- Consumes: Task 4·5·6·7 전부
- Produces: 동작하는 워커

**Why:** 여기까지는 어느 것도 실행되지 않는다. 명부를 받아 인덱스를 만들고, RSS 플랜을 DART 플랜 옆에 꽂고, 뉴스 이벤트가 뉴스 포맷으로 나가게 한다.

- [ ] **Step 1: config 테스트를 쓴다**

```ts
it('NEWS_ENABLED 기본값은 false — 배포와 활성화를 분리한다', () => {
  expect(loadConfig(base()).newsEnabled).toBe(false)
})

it('NEWS_ENABLED=true면 켜진다', () => {
  expect(loadConfig({ ...base(), NEWS_ENABLED: 'true' }).newsEnabled).toBe(true)
})

it('NEWS_INTERVAL_MS 기본값은 60초 — 조건부 요청이 거의 안 먹어 매번 전문을 받는다', () => {
  expect(loadConfig(base()).newsIntervalMs).toBe(60_000)
})

it('빈 문자열은 기본값으로 접힌다', () => {
  expect(loadConfig({ ...base(), NEWS_INTERVAL_MS: '' }).newsIntervalMs).toBe(60_000)
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/config.test.ts`
Expected: FAIL — `newsEnabled` 가 없다

- [ ] **Step 3: config 를 고친다**

`envSchema` 에 추가한다.

```ts
  // 배포와 활성화를 분리한다. 이미지가 올라간 뒤에도 켜기 전까지 기존 동작
  // 그대로이므로, 뉴스가 채널을 뒤덮으면 이미지를 되돌리지 않고 끌 수 있다.
  NEWS_ENABLED: optionalField(z.enum(['true', 'false']).default('false')),
  // 60초. RSS 반영 지연이 중앙값 3.5분(210초)이라 폴링 주기는 반올림 오차에 가깝고,
  // 조건부 요청이 실측상 5개 중 1개에서만 먹는다(스펙 §4.3) — 나머지는 매번 전문을
  // 다시 받는다. 30초면 하루 1.2GB, 60초면 0.6GB이고 지연은 6.7%만 나빠진다.
  NEWS_INTERVAL_MS: optionalField(
    z.coerce.number().int().positive().default(60_000),
  ),
```

`Config` 타입과 `loadConfig` 반환에 추가한다.

```ts
  newsEnabled: boolean
  newsIntervalMs: number
```
```ts
    newsEnabled: parsed.NEWS_ENABLED === 'true',
    newsIntervalMs: parsed.NEWS_INTERVAL_MS,
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/config.test.ts`
Expected: PASS

- [ ] **Step 5: `dispatch.ts` 가 소스에 맞는 포맷을 쓰게 한다**

발송 자리가 **세 곳**이다(`dispatch.ts:40`, `:56`, `:62`). 셋 다 고쳐야 한다.

```ts
import { formatEvent, formatMerged, formatNewsEvent, formatNewsMerged } from '../core/format.js'

const isNews = (i: PendingOutbox): boolean => i.event.sourceId === 'news'
const one = (i: PendingOutbox, summary?: string): string =>
  isNews(i) ? formatNewsEvent(i.event, i.tier) : formatEvent(i.event, i.tier, summary)
```

**(a) critical 개별 발송 (`:40`)**

```ts
    await sendOne(deps, item, one(item), now, stats)
```

**(b) 병합 (`:56`) — 소스별로 나눠 묶는다.** 한 메시지에 섞으면 헤더가 둘 중 하나로
거짓말을 하게 된다. `others` 를 뉴스와 그 외로 가른 뒤 각각 기존 병합 로직을 태운다.

```ts
    const newsOthers = others.filter(isNews)
    const dartOthers = others.filter((i) => !isNews(i))
    for (const [group, fmt] of [
      [dartOthers, formatMerged] as const,
      [newsOthers, formatNewsMerged] as const,
    ]) {
      if (group.length === 0) continue
      if (group.length >= MERGE_THRESHOLD) {
        const batch: PendingOutbox[] = []
        for (const item of group) {
          const next = [...batch, item]
          if (fmt(next.map((i) => ({ event: i.event, tier: i.tier }))).length > MAX_MERGED_CHARS) break
          batch.push(item)
        }
        const res = await deps.notifier.send(fmt(batch.map((i) => ({ event: i.event, tier: i.tier }))))
        for (const item of batch) await applyResult(deps, item, res, now, stats)
      } else {
        for (const item of group) {
          // 뉴스는 요약기를 태우지 않는다 — description 을 넘길 수 없어 입력이 제목뿐이고,
          // 그 제목은 같은 메시지 두 줄 위에 이미 찍혀 나간다 (main.ts 의 noopSummarizer 주석과 같은 이유).
          const summary = isNews(item) ? undefined : (await deps.summarizer.summarize(item.event)) ?? undefined
          await sendOne(deps, item, one(item, summary), now, stats)
        }
      }
    }
```

**(c) 위 `else` 가지가 기존 `:62` 를 대체한다.** 기존 `if (others.length >= MERGE_THRESHOLD)`
블록 전체를 위 코드로 바꾼다.

기존 DART 테스트가 전부 통과해야 한다 — 뉴스가 하나도 없으면 `newsOthers` 가 비어
`dartOthers` 만 기존과 동일한 경로를 탄다.

- [ ] **Step 6: `main.ts` 를 배선한다**

```ts
import { createRssSource, FEEDS } from './adapters/sources/rss.js'
import { fetchCorpEntries } from './adapters/sources/corp-code.js'
import { buildCorpIndex } from './core/news/corp-index.js'
import { evaluateNews } from './core/news/rules.js'
import { evaluateDart } from './core/dart/rules.js'
import { pollIntervalMs } from './core/schedule.js'
import type { SourcePlan } from './pipeline/ingest.js'

  const plans: SourcePlan[] = [{
    source: createDartSource({ apiKey: cfg.dartApiKey }),
    evaluate: evaluateDart,
    intervalMs: pollIntervalMs,
    countsAgainstApiBudget: true,
  }]

  if (cfg.newsEnabled) {
    // 명부를 못 받으면 기동을 중단한다. 빈 명부로 돌면 모든 뉴스가
    // no-corp-match 로 drop 되면서 워커는 정상으로 보이고 알림만 0건이 된다.
    const corpIndex = buildCorpIndex(await fetchCorpEntries(cfg.dartApiKey))
    const rss = createRssSource({
      feeds: FEEDS,
      onFeedError: (feedId, err) => log.error({ err, feedId }, 'rss feed failed'),
    })
    log.info({ corps: corpIndex.byLength.length, feeds: FEEDS.length }, 'news source enabled')
    plans.push({
      source: rss,
      // description 은 판정에만 쓰고 이벤트에 담지 않으므로 여기서 꺼내 넘긴다.
      evaluate: (e) => evaluateNews(e, corpIndex, rss.descriptionOf(e.externalId)),
      intervalMs: () => cfg.newsIntervalMs,
      countsAgainstApiBudget: false,
    })
  }
```

`runLoop` 초기 상태를 소스별 Map 으로 만든다.

```ts
  const seen = new Map<string, SeenSet>()
  for (const p of plans) {
    seen.set(p.source.id, createSeenSet(await store.recentExternalIds(p.source.id, SEEN_CAPACITY)))
  }
  const coldStart = new Map(plans.map((p) => [p.source.id, true]))
  const nextRunAt = new Map(plans.map((p) => [p.source.id, 0]))
```

- [ ] **Step 7: `.env.example` 에 추가한다**

```bash
# 뉴스 소스 (3단계). 기본은 꺼짐 — 배포와 활성화를 분리한다.
NEWS_ENABLED=false
# RSS 폴링 주기(ms). 반영 지연이 중앙값 3.5분이고 조건부 요청이 5곳 중 1곳에서만
# 먹어 나머지는 매번 전문을 다시 받는다 — 30초면 하루 1.2GB, 60초면 0.6GB다.
NEWS_INTERVAL_MS=60000
```

- [ ] **Step 8: 전체 검증**

Run: `cd apps/worker && npx vitest run && npx tsc --noEmit && npx tsc -p tsconfig.json && node -e "require('node:fs').accessSync('dist/main.js')"`
Expected: 전부 통과. **`tsc` 후 `node dist/main.js` 로만 실행된다 — `.ts` 를 직접 실행할 수 없다.**

- [ ] **Step 9: 커밋**

```bash
git add apps/worker/src/config.ts apps/worker/src/main.ts \
        apps/worker/src/pipeline/dispatch.ts apps/worker/src/config.test.ts .env.example
git commit -m "feat(news): 뉴스 소스를 배선한다 — NEWS_ENABLED 로 분리

배포와 활성화를 분리했다. 이미지가 올라간 뒤에도 켜기 전까지 기존
동작 그대로이므로, 뉴스가 채널을 뒤덮으면 이미지를 되돌리지 않고 끌 수
있다.

명부를 못 받으면 기동을 중단한다. 빈 명부로 돌면 모든 뉴스가
no-corp-match 로 drop 되면서 워커는 정상으로 보이고 알림만 0건이 된다.

폴링 주기 기본값은 30초다. RSS 반영 지연이 중앙값 3.5분이라(스펙
§4.2) 그 앞에서 폴링 주기는 반올림 오차다."
```

---

### Task 9: 보관 정책

**Files:**
- Create: `apps/worker/src/core/retention.ts`, `apps/worker/src/core/retention.test.ts`
- Modify: `apps/worker/src/ports/store.ts`, `apps/worker/src/adapters/store/postgres.ts`
- Test: `apps/worker/src/adapters/store/postgres.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `RETENTION_DAYS = 90`, `retentionCutoff(now: Date): Date`, `EventStore.pruneOlderThan(cutoff: Date): Promise<{ events: number; outbox: number }>`

**Why:** 스펙 §6.2·§6.3. 삭제 로직이 아예 없어 `events` 와 종결된 `outbox` 행이 영원히 쌓인다. 보관 없이 뉴스를 쌓으면 1년에 742MB 로 무료 티어(500MB)를 넘긴다.

- [ ] **Step 1: 순수 함수 테스트를 쓴다**

```ts
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
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/core/retention.test.ts`
Expected: FAIL

- [ ] **Step 3: `retention.ts` 를 쓴다**

```ts
/**
 * events 와 종결된 outbox 행의 보관 기간.
 *
 * 90일인 이유는 저장량이다(스펙 §6.2). 보관 정책 없이 뉴스를 쌓으면 1년에
 * 742MB 로 Supabase 무료 티어 500MB 를 넘긴다. 90일이면 183MB 에서 평형을
 * 이루고 더 늘지 않는다.
 *
 * 튜닝에는 90일이면 충분하다 — 1단계 필터를 27.9건/일에서 58.1건/일로 만든
 * 분석이 4주치 데이터로 이루어졌다.
 */
export const RETENTION_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000

/** 이 시각보다 오래된 행이 삭제 대상이다. core 는 순수해야 하므로 now 를 받는다. */
export function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - RETENTION_DAYS * DAY_MS)
}
```

- [ ] **Step 4: 스토어 테스트를 쓴다**

```ts
it('pruneOlderThan은 오래된 events와 종결된 outbox를 지운다', async () => {
  const store = createPostgresStore(db)
  const n = await store.pruneOlderThan(new Date('2026-06-22T00:00:00Z'))
  expect(n).toEqual({ events: expect.any(Number), outbox: expect.any(Number) })
})

it('pending 상태의 outbox는 아무리 오래돼도 지우지 않는다', async () => {
  // outbox 삭제 조건에 status in ('sent','dead') 가 들어가야 한다.
  // 미발송 건을 지우면 알림이 조용히 사라진다.
  const sql = capturedSql()
  await createPostgresStore(db).pruneOlderThan(new Date('2026-06-22T00:00:00Z'))
  expect(sql).toMatch(/status/)
  expect(sql).not.toMatch(/pending/)
})
```

- [ ] **Step 5: 포트와 어댑터를 고친다**

`ports/store.ts` 에 추가한다.

```ts
  /**
   * `cutoff` 보다 오래된 events 와, 그에 딸린 **종결된**(sent/dead) outbox 행을 지운다.
   *
   * pending 은 아무리 오래돼도 지우지 않는다 — 미발송 건을 지우면 알림이 조용히
   * 사라지고, 그 사실을 알 방법도 남지 않는다. 만료된 pending 은 dispatch 가
   * expiresAt 으로 이미 정리한다.
   *
   * outbox 를 먼저 지운다. events.id 를 참조하는 외래키가 있어 순서가 바뀌면
   * 제약 위반으로 트랜잭션이 통째로 실패한다.
   */
  pruneOlderThan(cutoff: Date): Promise<{ events: number; outbox: number }>
```

`adapters/store/postgres.ts` 에 구현한다.

```ts
    async pruneOlderThan(cutoff: Date) {
      return db.transaction(async (tx) => {
        const ob = await tx.delete(outbox).where(
          and(
            inArray(outbox.status, ['sent', 'dead']),
            inArray(
              outbox.eventId,
              tx.select({ id: events.id }).from(events).where(lt(events.firstSeenAt, cutoff)),
            ),
          ),
        ).returning({ id: outbox.id })

        const ev = await tx.delete(events)
          .where(lt(events.firstSeenAt, cutoff))
          .returning({ id: events.id })

        return { events: ev.length, outbox: ob.length }
      })
    },
```

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/core/retention.test.ts src/adapters/store/postgres.test.ts`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add apps/worker/src/core/retention.ts apps/worker/src/core/retention.test.ts \
        apps/worker/src/ports/store.ts apps/worker/src/adapters/store/postgres.ts \
        apps/worker/src/adapters/store/postgres.test.ts
git commit -m "feat(store): 90일 보관 정책 — 삭제 로직이 아예 없었다

events 도 outbox 도 영원히 쌓이고 있었다. 발송 완료된 sent/dead 행이
그대로 남아, 스키마 주석이 경고한 '순차 스캔 비용이 매 사이클에
얹힌다'가 실제로 진행 중이었다.

90일인 이유는 저장량이다(스펙 §6.2). 보관 없이 뉴스를 쌓으면 1년에
742MB 로 무료 티어 500MB 를 넘긴다. 90일이면 183MB 평형이다.

pending 은 아무리 오래돼도 지우지 않는다 — 미발송 건을 지우면 알림이
조용히 사라지고 그 사실을 알 방법도 남지 않는다.

outbox 를 먼저 지운다. events.id 외래키가 있어 순서가 바뀌면 제약
위반으로 트랜잭션이 통째로 실패한다."
```

---

### Task 10: 보관 배치를 루프에 붙인다

**Files:**
- Create: `apps/worker/src/pipeline/retention.ts`, `apps/worker/src/pipeline/retention.test.ts`
- Modify: `apps/worker/src/pipeline/cycle.ts`

**Interfaces:**
- Consumes: Task 9 의 `retentionCutoff`, `EventStore.pruneOlderThan`
- Produces: `runRetention(deps, lastPruneDate, now): Promise<string>`

**Why:** Task 9 는 함수만 만들었다. 하루 한 번 실제로 돌지 않으면 아무 효과가 없다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
import { describe, it, expect, vi } from 'vitest'
import { runRetention } from './retention.js'

const deps = () => ({
  store: { pruneOlderThan: vi.fn().mockResolvedValue({ events: 10, outbox: 3 }) },
  log: { info: vi.fn(), error: vi.fn() },
})

describe('runRetention', () => {
  it('날짜가 바뀌면 한 번 돈다', async () => {
    const d = deps()
    const next = await runRetention(d as never, '2026-09-19', new Date('2026-09-20T01:00:00Z'))
    expect(d.store.pruneOlderThan).toHaveBeenCalledTimes(1)
    expect(next).toBe('2026-09-20')
  })

  it('같은 날 두 번째 사이클에는 돌지 않는다', async () => {
    const d = deps()
    const next = await runRetention(d as never, '2026-09-20', new Date('2026-09-20T05:00:00Z'))
    expect(d.store.pruneOlderThan).not.toHaveBeenCalled()
    expect(next).toBe('2026-09-20')
  })

  it('삭제가 실패해도 던지지 않는다 — 정리 실패로 수집이 멈추면 안 된다', async () => {
    const d = deps()
    d.store.pruneOlderThan.mockRejectedValue(new Error('deadlock'))
    const next = await runRetention(d as never, '2026-09-19', new Date('2026-09-20T01:00:00Z'))
    expect(d.log.error).toHaveBeenCalled()
    // 날짜를 넘기지 않아 다음 사이클이 다시 시도한다
    expect(next).toBe('2026-09-19')
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `cd apps/worker && npx vitest run src/pipeline/retention.test.ts`
Expected: FAIL

- [ ] **Step 3: 구현을 쓴다**

```ts
import { kstDateString } from '../core/budget.js'
import { retentionCutoff } from '../core/retention.js'
import type { EventStore } from '../ports/store.js'

/** cycle.ts 의 CycleLogger 와 구조적으로 호환된다 — 순환 import 를 피하려고 여기서 따로 정의한다.
 *  digest.ts 가 DigestLogger 를 같은 이유로 따로 두고 있다. */
export type RetentionLogger = {
  info(obj: Record<string, unknown> | string, msg?: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

export type RetentionDeps = { store: EventStore; log: RetentionLogger }

/**
 * 하루 한 번 오래된 행을 지운다. 다이제스트와 같은 자리에서 KST 날짜가 바뀔 때
 * 실행한다.
 *
 * 실패해도 던지지 않는다 — 정리는 수집·발송보다 덜 급하다. 여기서 던지면 사이클
 * catch 로 가 서킷 브레이커가 발동하고, 디스크 정리 실패 때문에 알림이 멈춘다.
 * 대신 날짜를 넘기지 않아 다음 사이클이 다시 시도한다.
 */
export async function runRetention(
  deps: RetentionDeps, lastPruneDate: string, now: Date,
): Promise<string> {
  const today = kstDateString(now)
  if (today === lastPruneDate) return lastPruneDate

  try {
    const cutoff = retentionCutoff(now)
    const n = await deps.store.pruneOlderThan(cutoff)
    deps.log.info({ cutoff: cutoff.toISOString(), ...n }, 'retention pruned')
    return today
  } catch (err) {
    deps.log.error({ err }, 'retention failed — will retry next cycle')
    return lastPruneDate
  }
}
```

- [ ] **Step 4: `cycle.ts` 에 배선한다**

`CycleState` 에 `lastPruneDate: string` 을 추가하고, `catchUpDigests` 바로 뒤에서 부른다.

```ts
    const lastPruneDate = await runRetention(
      { store: deps.store, log: deps.log }, state.lastPruneDate, now,
    )
```

`main.ts` 의 초기 상태에 `lastPruneDate: kstDateString(new Date())` 를 넣는다 — 기동 직후에 바로 돌지 않게 한다.

- [ ] **Step 5: 전체 테스트**

Run: `cd apps/worker && npx vitest run && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add apps/worker/src/pipeline/retention.ts apps/worker/src/pipeline/retention.test.ts \
        apps/worker/src/pipeline/cycle.ts apps/worker/src/main.ts
git commit -m "feat(worker): 보관 배치를 하루 한 번 돌린다

Task 9 는 함수만 만들었다. 실제로 돌지 않으면 아무 효과가 없다.

실패해도 던지지 않는다 — 여기서 던지면 사이클 catch 로 가 서킷
브레이커가 발동하고, 디스크 정리 실패 때문에 알림이 멈춘다. 날짜를
넘기지 않아 다음 사이클이 다시 시도한다."
```

---

### Task 11: 덤프 백업

**Files:**
- Create: `.github/workflows/backup.yml`, `scripts/backup-events.sh`
- Modify: `docs/deploy-oci.md`

**Interfaces:**
- Consumes: 없음 (운영 스크립트)
- Produces: 주 1회 `events` 덤프 아티팩트

**Why:** 스펙 §6.4. 뉴스를 붙이는 순간 DB 가 유일본인 데이터가 생긴다. DART 는 API 에서 재수집할 수 있지만 뉴스는 못 하고, 우리가 내린 `verdict`/`rule` 은 어디에도 없다. 무료 티어에는 자동 백업이 없다.

- [ ] **Step 1: 백업 스크립트를 쓴다**

```bash
#!/usr/bin/env bash
# events 테이블을 압축 덤프한다. 스펙 §6.4 — 뉴스를 붙이면 DB 가 유일본이 된다.
# DART 는 API 에서 재수집할 수 있지만 뉴스는 못 하고, 우리가 내린 verdict/rule 은
# 어디에도 없다. 무료 티어에는 자동 백업이 없다.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL이 필요합니다}"
OUT="${1:-events-$(date -u +%Y%m%d).csv.gz}"

# outbox 는 받지 않는다 — 발송 상태는 재구성 가능하고, 튜닝 가치가 있는 것은
# events 의 verdict/rule/raw 뿐이다.
psql "$DATABASE_URL" -c "\copy (
  SELECT id, source_id, external_id, occurred_at, first_seen_at,
         title, url, corp_name, ticker, market, verdict, tier, rule
  FROM events ORDER BY id
) TO STDOUT WITH CSV HEADER" | gzip -9 > "$OUT"

echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
```

- [ ] **Step 2: 실행 권한을 주고 로컬에서 확인한다**

```bash
chmod +x scripts/backup-events.sh
bash -n scripts/backup-events.sh   # 문법 검사
```
Expected: 오류 없음

- [ ] **Step 3: 워크플로를 쓴다**

```yaml
name: Backup events

on:
  schedule:
    - cron: '0 18 * * 0'   # 매주 월요일 KST 03:00
  workflow_dispatch:

jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # ubuntu-latest 에 postgresql-client 가 있다고 가정하지 않는다. 없으면 백업이
      # 조용히 실패하는데, 백업은 실패를 알아차리기 가장 어려운 종류의 작업이다.
      - name: Ensure psql
        run: psql --version || (sudo apt-get update && sudo apt-get install -y postgresql-client)
      - name: Dump events
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
        run: ./scripts/backup-events.sh events.csv.gz
      - uses: actions/upload-artifact@v4
        with:
          name: events-${{ github.run_id }}
          path: events.csv.gz
          # 무료 플랜의 아티팩트 보관 한도 안에서 가장 길게 잡는다.
          retention-days: 90
```

- [ ] **Step 4: `DATABASE_URL` 시크릿이 있는지 확인한다**

```bash
gh secret list | grep DATABASE_URL || echo "없음 — 등록 필요"
```

없으면 **파일에서 읽어 등록한다. 값을 화면에 찍지 않는다.**

```bash
gh secret set DATABASE_URL < /path/to/file-containing-only-the-url
```

- [ ] **Step 5: 워크플로를 수동 실행해 검증한다**

```bash
gh workflow run backup.yml
gh run watch
```
Expected: 성공, 아티팩트에 `events.csv.gz` 가 생긴다. **실제로 아티팩트를 받아 행 수를 확인한다** — 0바이트 성공은 실패다.

- [ ] **Step 6: 문서화하고 커밋**

`docs/deploy-oci.md` 에 백업 절과 복구 절차를 추가한 뒤:

```bash
git add scripts/backup-events.sh .github/workflows/backup.yml docs/deploy-oci.md
git commit -m "ci: events 주간 덤프 백업

뉴스를 붙이면 DB 가 유일본인 데이터가 생긴다(스펙 §6.4). DART 는 API
에서 재수집할 수 있지만 뉴스는 못 하고, 우리가 내린 verdict/rule 은
어디에도 없다. 무료 티어에는 자동 백업이 없다.

outbox 는 받지 않는다 — 발송 상태는 재구성 가능하고, 튜닝 가치가
있는 것은 events 의 verdict/rule 뿐이다."
```

---

## 완료 기준

- [ ] `pnpm -r test` 와 `pnpm -r typecheck` 통과
- [ ] `NEWS_ENABLED=false` 로 배포했을 때 **알림 경로의 기존 DART 동작이 바뀌지 않는다** — 소스·판정·발송·다이제스트 어디에도 뉴스가 끼어들지 않는다
  > **원래 여기 적혀 있던 "기존 DART 동작이 한 글자도 바뀌지 않는다" 는 사실이 아니었다.** 알림 경로에 대해서는 참이지만 **보관 정리에 대해서는 거짓**이다 — `runRetention` 은 `NEWS_ENABLED` 와 무관하게 사이클마다 호출되므로, 이 브랜치의 이미지가 올라간 뒤 첫 KST 자정에 90일 지난 `events` 와 종결된 `outbox` 행이 영구 삭제된다. 3b 에서 새로 들어온 동작이고 스위치는 `RETENTION_ENABLED` 로 따로 있다(기본 꺼짐).
  >
  > **기존 테스트로는 이 차이를 잡을 수 없었다.** "기존 테스트가 전부 통과하는 것으로 확인한다" 는 확인 방법 자체가 틀렸다 — 삭제 경로는 새로 추가된 코드라 기존 테스트가 아예 건드리지 않고, 통과한다는 사실이 "동작이 그대로다" 를 뜻하지 않는다. 지금은 `RETENTION_ENABLED` 가 꺼져 있을 때 `pruneOlderThan` 이 **한 번도 불리지 않는다**는 것을 `pipeline/cycle.test.ts` 가 직접 단언한다.
- [ ] `RETENTION_ENABLED` 를 비워둔 채 배포했을 때 **한 행도 지워지지 않는다** — 기동 로그에 `retention disabled` 가 찍히고 `retention pruned` 는 찍히지 않는다
- [ ] `NEWS_ENABLED=true` 로 켰을 때 로그에 `news source enabled` 와 상장사 수가 찍힌다
- [ ] 발송된 뉴스 메시지에 `description` 원문이 없고 영향 해석이 없다
- [ ] 백업 워크플로를 최소 한 번 돌려 아티팩트 행 수를 확인한 **뒤에** `RETENTION_ENABLED=true` 로 켠다
- [ ] 켠 뒤 보관 배치가 하루 한 번 돌고 로그에 삭제 건수가 남는다
- [ ] 백업 워크플로가 실제 아티팩트를 만들고, 받아서 행 수를 확인했다

## 이 계획이 다루지 않는 것

- **매크로 트랙과 클러스터링(3c)** — 임계값을 정하려면 3a 운영 데이터가 있어야 한다. 지금 쓰면 근거 없는 숫자를 박게 된다.
- **주가 라벨링(3d)** — 같은 이유.
- **네이버 뉴스 검색 API** — 약관과 한도가 미확인이다(스펙 §9).
- **평일 장중 재측정** — RSS 지연·기사량 실측 표본이 일요일 저녁이다. 3a 첫 주에 다시 잰다.
- **상장사 명부 자동 갱신** — 기동 시 한 번만 받는다. 신규 상장은 워커를 재시작해야 반영된다. 재배포가 잦은 동안은 문제가 되지 않고, 3c 에서 보관 배치 옆에 하루 1회 갱신을 붙인다.
- **뉴스 다이제스트** — `catchUpDigests` 는 `sourceId: 'dart'` 로 고정된다. 뉴스의 drop 통계는 `events` 에 쌓이므로 DB 조회로 볼 수 있고, 운영자 다이제스트에 넣는 것은 3c 로 미룬다.
