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

  it('범위를 벗어난 숫자 문자 참조가 title에 있어도 던지지 않고 item을 돌려준다', () => {
    const make = (title: string) =>
      `<rss><channel><item><title>${title}</title><link>https://x/1</link></item></channel></rss>`

    expect(() => parseRssFeed(make('&#1114112;'))).not.toThrow()
    expect(parseRssFeed(make('&#1114112;'))[0]!.title).toBe('&#1114112;')

    expect(() => parseRssFeed(make('&#99999999999999;'))).not.toThrow()
    expect(parseRssFeed(make('&#99999999999999;'))[0]!.title).toBe('&#99999999999999;')

    expect(() => parseRssFeed(make('&#x110000;'))).not.toThrow()
    expect(parseRssFeed(make('&#x110000;'))[0]!.title).toBe('&#x110000;')
  })

  it('한 item의 숫자 참조가 범위를 벗어나도 같은 호출의 다른 item들을 잃지 않는다', () => {
    // 예외가 <item> 루프 안에서 던져지면 그 사이클에서 이미 파싱된 item들까지
    // 통째로 날아간다 — 망가진 기사 하나가 피드 전체의 배치를 죽이는 셈이라
    // '망가진 XML은 빈 배열을 돌려준다' 계약이 지키려는 것과 같은 문제다.
    const feed = `<rss><channel>
      <item><title>정상 기사</title><link>https://x/1</link></item>
      <item><title>&#1114112;</title><link>https://x/2</link></item>
    </channel></rss>`
    const items = parseRssFeed(feed)
    expect(items).toHaveLength(2)
    expect(items[0]!.title).toBe('정상 기사')
    expect(items[1]!.title).toBe('&#1114112;')
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

  it('범위를 벗어난 숫자 문자 참조는 던지지 않고 원문 그대로 남긴다', () => {
    // String.fromCodePoint 는 U+10FFFF(1114111)를 넘으면 RangeError 를 던진다.
    // 인식 못 하는 named entity를 원문 그대로 돌려주는 것과 같은 원칙으로,
    // 범위를 벗어난 숫자 참조도 원문 그대로 남긴다.
    expect(decodeEntities('&#1114112;')).toBe('&#1114112;')
    expect(decodeEntities('&#99999999999999;')).toBe('&#99999999999999;')
    expect(decodeEntities('&#x110000;')).toBe('&#x110000;')
  })

  it('회귀 방지: 엔티티로 인식되지 않아야 할 입력은 그대로 남고, 유효 범위 안의 외톨이 서로게이트는 정상 디코딩된다', () => {
    expect(decodeEntities('&#;')).toBe('&#;')
    expect(decodeEntities('&quot')).toBe('&quot')
    expect(decodeEntities('A & B & C')).toBe('A & B & C')
    // U+D800 은 외톨이 서로게이트라 유효한 문자열은 아니지만, 유효 코드포인트
    // 범위(0~U+10FFFF) 안에 있어 String.fromCodePoint 가 던지지 않고 받아준다.
    expect(decodeEntities('&#55296;')).toBe(String.fromCodePoint(55296))
  })
})
