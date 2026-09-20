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
