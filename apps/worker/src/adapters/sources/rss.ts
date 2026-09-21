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
  /**
   * 한 피드가 죽어도 나머지는 살아야 한다. 실패는 오직 이 콜백으로만 보고된다 —
   * 넘기지 않으면 그 피드의 실패는 로그 한 줄 없이 조용히 사라진다. (실제
   * 로거 연결은 다음 태스크.)
   */
  onFeedError?: (feedId: string, err: unknown) => void
}

export type RssSource = EventSource & {
  /**
   * 판정에만 쓰는 원문 요약. 저장·발송하지 않으므로 NormalizedEvent 에 담지 않고
   * 마지막 fetch 분만 여기 남긴다 (스펙 §4.3, 저작권).
   */
  descriptionOf(externalId: string): string
}

type FeedFetchResult = { events: NormalizedEvent[]; descriptions: Map<string, string> }

export function createRssSource(cfg: RssSourceConfig): RssSource {
  const doFetch = cfg.fetchImpl ?? fetch
  const validators = new Map<string, { etag?: string; lastModified?: string }>()
  let descriptions = new Map<string, string>()

  // 피드 하나를 받아온다. 실패하면(HTTP 오류, 네트워크 오류, 본문 읽기 실패 등)
  // 그대로 던진다 — 호출부가 Promise.allSettled 로 모아서 개별 격리한다.
  async function fetchOneFeed(feed: FeedConfig, now: Date): Promise<FeedFetchResult | null> {
    const v = validators.get(feed.id)
    const headers: Record<string, string> = { 'User-Agent': 'market-radar/1.0' }
    if (v?.etag) headers['If-None-Match'] = v.etag
    if (v?.lastModified) headers['If-Modified-Since'] = v.lastModified

    const res = await doFetch(feed.url, {
      headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    // 바뀐 게 없다 — 본문을 받지 않고 넘어간다.
    if (res.status === 304) return null
    if (!res.ok) throw new Error(`RSS HTTP ${res.status}`)

    // validator 는 본문을 실제로 읽고 파싱까지 끝낸 뒤에만 커밋한다. 헤더가
    // 도착한 직후에 저장하면, AbortSignal.timeout 이 본문 전송 도중(느리거나 큰
    // 피드) 끊겼을 때도 "받은 적 없는 콘텐츠"의 validator 가 이미 저장된다.
    // 다음 폴링이 그 validator 로 If-None-Match 를 보내면 서버는 304 를 주고
    // 우리는 그냥 continue 하므로, 실제로는 한 번도 못 받은 그 배치의 기사들이
    // 피드 내용이 다시 바뀔 때까지 영영 안 보인다 — 에러도 없이 조용히.
    const text = await res.text()
    const items = parseRssFeed(text)

    const etag = res.headers.get('etag') ?? undefined
    const lastModified = res.headers.get('last-modified') ?? undefined
    // 이번 200 이 validator 를 안 줬다면 지난 validator 도 더는 못 믿는다.
    // 조건 없이 덮어쓰지 않으면(=지우지 않으면) 이후 요청에 계속 옛
    // If-None-Match 를 실어 보내게 된다.
    if (etag || lastModified) {
      validators.set(feed.id, { etag, lastModified })
    } else {
      validators.delete(feed.id)
    }

    const events: NormalizedEvent[] = []
    const itemDescriptions = new Map<string, string>()
    for (const item of items) {
      const externalId = `${feed.id}:${item.guid}`
      itemDescriptions.set(externalId, item.description)
      events.push({
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
    return { events, descriptions: itemDescriptions }
  }

  return {
    id: 'news',

    descriptionOf: (externalId: string) => descriptions.get(externalId) ?? '',

    async fetchLatest(now: Date): Promise<NormalizedEvent[]> {
      const out: NormalizedEvent[] = []
      const nextDescriptions = new Map<string, string>()

      // 피드마다 호스트가 다르다 — 동시에 fetch 해도 한 호스트에 여러 요청을
      // 몰아넣는 게 아니라 호스트당 한 요청이다. 순차로 돌면 피드 하나가
      // 타임아웃(10s)까지 가는 것만으로 fetchLatest 전체가 그만큼 늦어지고,
      // 다음 태스크에서 이 소스가 공시 폴링과 같은 루프를 타면 그 지연이 정작
      // 지연이 문제가 되는 공시 쪽까지 밀어낸다.
      const results = await Promise.allSettled(
        cfg.feeds.map((feed) => fetchOneFeed(feed, now)),
      )

      // Promise.allSettled 는 완료 순서가 아니라 입력(cfg.feeds) 순서를 그대로
      // 보존한다 — 그래서 아래에서 순서대로 합치면 반환 이벤트 순서는 기존
      // (순차 for-loop) 구현과 동일하게 유지된다.
      results.forEach((result, i) => {
        const feed = cfg.feeds[i]!
        if (result.status === 'rejected') {
          // 한 매체의 장애가 나머지 매체를 막으면 안 된다. 실패는 오직
          // onFeedError 로만 보고된다 — 안 넘기면 흔적 없이 사라진다.
          cfg.onFeedError?.(feed.id, result.reason)
          return
        }
        if (result.value === null) return // 304
        out.push(...result.value.events)
        for (const [externalId, description] of result.value.descriptions) {
          nextDescriptions.set(externalId, description)
        }
      })

      descriptions = nextDescriptions
      return out
    },
  }
}
