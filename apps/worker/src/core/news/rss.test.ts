import { describe, it, expect } from 'vitest'
import { parseRssFeed, decodeEntities } from './rss.js'

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

describe('decodeEntities', () => {
  it('숫자 참조가 만든 &를 뒤이은 평문과 엮어 다시 엔티티로 재해석하지 않는다', () => {
    // &#38; 는 리터럴 "&" 하나를 뜻하는 숫자 참조다. 그 뒤의 "lt;"/"gt;" 는
    // 소스에 원래부터 있던 평문이지, 앞 단계가 만든 "&"와 합쳐져야 할
    // 엔티티가 아니다. 순차(hex→decimal→named) 치환이면 decimal 패스가
    // "&lt;" 를 만들고 named 패스가 그걸 또 "<" 로 풀어버린다.
    expect(decodeEntities('AT&#38;T defeats &#38;lt;Samsung&#38;gt;')).toBe(
      'AT&T defeats &lt;Samsung&gt;',
    )
  })

  it('16진수 참조가 만든 &도 재해석하지 않는다', () => {
    expect(decodeEntities('&#x26;quot;hello&#x26;quot;')).toBe('&quot;hello&quot;')
  })

  it('일반적인 단일 인코딩은 그대로 디코딩한다', () => {
    expect(decodeEntities('&quot;hi&quot; &#039;there&#039; A&amp;B')).toBe('"hi" \'there\' A&B')
  })
})
