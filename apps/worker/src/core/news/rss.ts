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

/**
 * 한 피드에서 한 번에 받아들일 item 수. 공시 어댑터는 목록 API 가 프로토콜상
 * 100건으로 막아 주지만 RSS 에는 그런 상한이 없다 — 피드 URL 이 바뀌거나 CDN 이
 * 아카이브 페이지를 물려주면 한 응답에 수만 건이 들어온다.
 *
 * 그 결과는 파싱 비용이 아니라 **직렬 DB 왕복**이다. runIngest 는 처음 보는 item
 * 하나마다 recordEvent 트랜잭션을 하나씩, 순차로 돌린다. 2만 건이면 2만 번이고,
 * 그 사이 같은 스레드의 공시 폴링은 다음 사이클로 넘어가지 못한다 — 통제 밖의
 * 입력 때문에 제품의 핵심 약속인 공시 알림이 수 분간 멎는다. heartbeat 은
 * finally 에서 계속 핑을 보내므로 외부 감시에는 내내 정상으로 보인다.
 *
 * 100 으로 맞추는 근거는 공시 쪽과 같은 수라서다. 실측(스펙 §4.2)에서 가장
 * 촘촘한 피드가 한 번에 120건을 줬으므로 정상 피드도 꼬리가 잘릴 수 있지만,
 * 잘리는 쪽은 **이미 지난 사이클에 본 오래된 기사**다(피드는 최신순이고 폴링은
 * 60초 주기다). 60초 안에 한 피드에서 100건이 새로 올라오는 상황이라면 그것
 * 자체가 정상이 아니다.
 *
 * 문서 순서의 앞에서부터 센다. 실측한 피드는 모두 최신순이다 — 만약 과거순으로
 * 주는 피드가 생기면 그 피드는 최신 기사를 못 보게 되므로, 새 피드를 붙일 때
 * 정렬을 확인해야 한다.
 */
export const MAX_ITEMS_PER_FEED = 100

/**
 * 제목 길이 상한. 제목은 **저장되고 발송된다** — 상한이 없으면 망가진 피드
 * 하나가 텔레그램 4,096자 한도를 넘는 메시지를 만들어(낱개 발송 경로는 병합
 * 경로와 달리 길이를 재지 않는다) 그 알림이 영영 발송에 실패하고, events 행도
 * 그만큼 부풀어 무료 티어 500MB 예산을 갉는다.
 *
 * 500 은 실측 국내 헤드라인(30~60자)의 약 10배다. 정상 제목은 절대 닿지 않고,
 * 닿는다면 그것은 제목이 아니라 본문이 흘러들어온 것이다.
 */
export const MAX_TITLE_CHARS = 500

/**
 * description 길이 상한. 이쪽은 저장도 발송도 하지 않고 **필터링에만** 쓰므로
 * (스펙 §4.3, 저작권) 자르는 데 따르는 손실은 판정 정확도뿐이다.
 *
 * 2,000 은 실측 최장(머니투데이 699자)의 약 3배다. 영향 키워드는 기사 앞부분에
 * 몰려 있고, 뒤쪽은 대개 관련기사 목록·저작권 고지라 판정에 기여하지 않는다.
 * 상한이 없으면 squash() 가 수 MB 문자열을 통째로 복사하고 그 위에서 키워드
 * 수십 개를 includes 로 훑는 일이 item 마다 반복된다.
 */
export const MAX_DESCRIPTION_CHARS = 2_000

/** 상한을 넘으면 앞에서부터 잘라낸다. 문자 단위이므로 서로게이트 쌍이 갈릴 수
 *  있지만, 잘린 꼬리는 키워드 매칭에만 쓰이거나(설명) 표시상 잘린 제목일 뿐이라
 *  실질적인 영향이 없다. */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

/**
 * `&quot;` `&#039;` `&#x27;` 를 실제 문자로 되돌린다.
 *
 * 반드시 한 번의 패스로 처리해야 한다. hex → decimal → named 순으로 나눠서
 * 세 번 replace 하면, 앞 단계가 만들어낸 `&` 를 뒤 단계가 다시 엔티티 시작으로
 * 오인해서 과잉 디코딩한다 — 예를 들어 `&#38;lt;` (문자 그대로 "&lt;" 를
 * 뜻하는 숫자 참조 + 평문)가 decimal 패스에서 `&lt;` 가 된 뒤, named 패스에서
 * 그걸 또 `<` 로 풀어버린다. 하나의 정규식/alternation 으로 한 번만 스캔하면
 * replace 가 만든 치환 결과를 다시 스캔하지 않으므로 이 문제가 없다.
 */
/**
 * 숫자 문자 참조를 실제 문자로 바꾼다. 유효 범위(0 ~ U+10FFFF)를 벗어나면
 * 원문(`literal`)을 그대로 돌려준다 — `String.fromCodePoint` 는 범위를 벗어나면
 * RangeError 를 던지는데, 이 함수는 parseRssFeed 의 <item> 루프 안에서 호출되므로
 * 여기서 던지면 그 사이클에서 이미 파싱한 항목들까지 통째로 날아간다. 하나의
 * 망가진 제목이 피드 전체를 죽이면 안 된다는 계약은 인식 못 하는 named entity를
 * 원문 그대로 돌려주는 `?? m` 폴백과 동일한 원칙이다.
 */
function toChar(codePoint: number, literal: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return literal
  return String.fromCodePoint(codePoint)
}

export function decodeEntities(s: string): string {
  return s.replace(
    /&#x([0-9a-f]+);|&#(\d+);|&([a-z]+);/gi,
    (m, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
      if (hex !== undefined) return toChar(parseInt(hex, 16), m)
      if (dec !== undefined) return toChar(Number(dec), m)
      return NAMED[name!.toLowerCase()] ?? m
    },
  )
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
    // 상한에 닿으면 남은 블록은 파싱조차 하지 않는다 — 비용의 대부분은 이
    // 뒤(디코딩과, 무엇보다 item 당 하나씩 도는 recordEvent 트랜잭션)에 있다.
    if (out.length >= MAX_ITEMS_PER_FEED) break
    const link = tag(block, 'link')
    // 멱등키를 만들 수 없는 item 은 버린다. 받아들이면 같은 기사를 매 사이클
    // 새 이벤트로 기록하게 된다.
    if (!link) continue
    const pd = tag(block, 'pubDate')
    const parsed = pd ? new Date(pd) : null
    out.push({
      guid: tag(block, 'guid') || link,
      title: truncate(tag(block, 'title'), MAX_TITLE_CHARS),
      link,
      description: truncate(tag(block, 'description'), MAX_DESCRIPTION_CHARS),
      pubDate: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
    })
  }
  return out
}
