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
      // status 304 는 null-body status 라 body 로 '' 조차 줄 수 없다 — Node(undici)
      // 의 Response 생성자가 "Invalid response status code 304" 로 던진다. null 만 허용.
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
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
