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
export function decodeEntities(s: string): string {
  return s.replace(
    /&#x([0-9a-f]+);|&#(\d+);|&([a-z]+);/gi,
    (m, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
      if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16))
      if (dec !== undefined) return String.fromCodePoint(Number(dec))
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
