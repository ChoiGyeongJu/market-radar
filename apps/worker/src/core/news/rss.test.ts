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
