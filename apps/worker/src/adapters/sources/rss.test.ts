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

  it('validator는 본문을 실제로 읽은 뒤에만 커밋된다 — 본문 읽기 실패 시 다음 요청에 If-None-Match를 보내지 않는다', async () => {
    // 헤더는 정상 도착(etag 포함)했지만 본문 스트림이 끊긴 상황을 흉내낸다.
    // AbortSignal.timeout 이 전송 도중 끊는 경우가 실제 경로다.
    const f = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? 'W/"v1"' : null) },
        text: () => Promise.reject(new Error('mid-transfer abort')),
      })
      .mockResolvedValueOnce(new Response(FEED('복구', 'https://x/3'), { status: 200 }))
    const src = createRssSource({
      feeds: [{ id: 'a', press: '연합', url: 'https://f/a' }],
      fetchImpl: f as unknown as typeof fetch,
    })

    const out1 = await src.fetchLatest(NOW)
    expect(out1).toHaveLength(0) // 본문을 못 읽었으니 이벤트도 없다

    const out2 = await src.fetchLatest(NOW)
    // validator 가 커밋됐다면 서버에 If-None-Match 를 보냈을 것이고, 두 번째
    // mock 은 무조건 200 을 주므로 이 자체로는 구분이 안 된다 — 헤더로 확인한다.
    expect(out2).toHaveLength(1)
    expect((f.mock.calls[1]![1] as RequestInit).headers).not.toHaveProperty('If-None-Match')
  })

  it('validator가 없는 200 응답을 받으면 이전 validator를 지운다', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(FEED('제목1', 'https://x/1'),
        { status: 200, headers: { etag: 'W/"v1"' } }))
      .mockResolvedValueOnce(new Response(FEED('제목2', 'https://x/2'), { status: 200 }))
      .mockResolvedValueOnce(new Response(FEED('제목3', 'https://x/3'), { status: 200 }))
    const src = createRssSource({
      feeds: [{ id: 'a', press: '연합', url: 'https://f/a' }],
      fetchImpl: f as unknown as typeof fetch,
    })

    await src.fetchLatest(NOW) // 1회차: etag 를 받는다
    await src.fetchLatest(NOW) // 2회차: 그 etag 를 보내지만, 응답엔 validator가 없다
    expect((f.mock.calls[1]![1] as RequestInit).headers)
      .toMatchObject({ 'If-None-Match': 'W/"v1"' })

    await src.fetchLatest(NOW) // 3회차: 지워졌어야 하니 If-None-Match 를 보내면 안 된다
    expect((f.mock.calls[2]![1] as RequestInit).headers).not.toHaveProperty('If-None-Match')
  })

  it('한 피드가 응답하지 않아도 나머지는 그 전에 이미 요청된다 — 순차가 아니라 동시', async () => {
    // 시간을 재는 대신 순서를 잰다: 느린 피드가 아직 안 끝났는데도 빠른 피드의
    // 요청이 이미 나갔는지를 직접 확인한다. 이러면 CI 러너가 얼마나 느리든
    // 결과가 흔들리지 않는다 — elapsed 를 재던 이전 버전은 부하가 큰 러너에서
    // 여유 마진(30ms)을 넘길 수 있었다.
    const requestOrder: string[] = []
    let releaseHang!: () => void
    const hang = new Promise<Response>((_, reject) => {
      releaseHang = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
    })

    const f = vi.fn((url: string) => {
      requestOrder.push(url)
      if (url === 'https://f/hang') return hang
      return Promise.resolve(new Response(FEED('신속', 'https://x/prompt'), { status: 200 }))
    })
    const src = createRssSource({
      feeds: [
        { id: 'hang', press: '느림', url: 'https://f/hang' },
        { id: 'prompt', press: '빠름', url: 'https://f/prompt' },
      ],
      fetchImpl: f as unknown as typeof fetch,
    })

    const pending = src.fetchLatest(NOW)

    // fetchLatest 가 각 피드의 fetch 를 Promise.allSettled(feeds.map(...)) 로
    // 동시에 시작한다면, hang 이 아직 reject 되지 않은 이 시점에 이미 두 URL
    // 모두 f 에 전달돼 있어야 한다. 순차 구현(for...of await)이었다면 hang 이
    // 걸려 있는 한 prompt 요청은 아예 나가지 않는다 — hang 을 풀어주기 전까지는
    // 영원히.
    expect(requestOrder).toContain('https://f/hang')
    expect(requestOrder).toContain('https://f/prompt')

    releaseHang()
    const out = await pending

    expect(out).toHaveLength(1)
    expect(out[0]!.title).toBe('신속')
  })
})
