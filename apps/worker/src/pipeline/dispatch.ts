import { formatEvent, formatMerged, formatNewsEvent, formatNewsMerged } from '../core/format.js'
import { MAX_MERGED_CHARS, MERGE_THRESHOLD } from '../core/policy.js'
import { MAX_ATTEMPTS, nextAttemptAt } from '../core/retry.js'
import { LOCAL_RATE_LIMIT } from '../ports/notifier.js'
import type { Notifier } from '../ports/notifier.js'
import type { EventStore, PendingOutbox } from '../ports/store.js'
import type { Summarizer } from '../ports/summarizer.js'

// 소스별로 포맷을 가른다. 뉴스는 subject 가 없어 공시 포맷(subjectLine)을 그대로
// 쓰면 안 되고, 병합 헤더도 "공시 N건"/"뉴스 N건" 이 서로를 대신할 수 없다.
const isNews = (i: PendingOutbox): boolean => i.event.sourceId === 'news'
const one = (i: PendingOutbox, summary?: string): string =>
  isNews(i) ? formatNewsEvent(i.event, i.tier) : formatEvent(i.event, i.tier, summary)

export type DispatchDeps = {
  store: EventStore
  notifier: Notifier
  summarizer: Summarizer
}

export type DispatchStats = { sent: number; failed: number; dead: number; expired: number }

const CLAIM_LIMIT = 20

export async function runDispatch(deps: DispatchDeps, now: Date): Promise<DispatchStats> {
  const stats: DispatchStats = { sent: 0, failed: 0, dead: 0, expired: 0 }
  const claimed = await deps.store.claimPending(now, CLAIM_LIMIT)
  if (claimed.length === 0) return stats

  // 만료 먼저 걷어낸다 — 늦은 알림은 보내지 않는다
  const live: PendingOutbox[] = []
  for (const item of claimed) {
    if (item.expiresAt.getTime() <= now.getTime()) {
      await deps.store.markDead(item.id, 'expired')
      stats.expired += 1
    } else {
      live.push(item)
    }
  }

  const criticals = live.filter((i) => i.tier === 'critical')
  const others = live.filter((i) => i.tier !== 'critical')

  // critical — 속도가 목적이므로 병합하지 않는다. 공시를 먼저 보낸다.
  // 두 소스가 같은 텔레그램 토큰 버킷(채팅 단위 — 버킷을 소스별로 나누면
  // 실제 한도를 넘겨 429를 부른다)을 공유하므로, 뉴스 critical 이 먼저 버킷을
  // 비우면 뒤따르는 공시 critical 이 LOCAL_RATE_LIMIT 로 밀려 5분 TTL 안에
  // 만료될 수 있다. 공시는 제품의 핵심 약속이고 뉴스는 부가 기능이므로, 버킷이
  // 마르면 기다리는 쪽은 뉴스여야 한다.
  const criticalDart = criticals.filter((i) => !isNews(i))
  const criticalNews = criticals.filter(isNews)
  for (const item of [...criticalDart, ...criticalNews]) {
    await sendOne(deps, item, one(item), now, stats)
  }

  // 그 외 — 임계 이상이면 한 메시지로 묶어 rate limit 압박을 줄인다.
  // 병합 메시지는 요약을 붙이지 않는다 — 개별 발송과 달리 알림에 요약이 있는지 여부가
  // "마침 그때 몇 건이 밀려 있었는가"로 결정되는 것은 의도된 지연·길이 트레이드오프다.
  //
  // 병합 여부는 소스 합계(others.length)로 한 번만 결정한다. 그룹별로 따로
  // 임계값을 매기면(예: 공시 2건 + 뉴스 2건, 합은 임계 이상) 각 그룹은 개별
  // 임계 미달이라 넷 다 낱개 발송된다 — 버킷 토큰을 실제보다 더 쓰고 위 critical
  // 기아를 악화시키며, 요약기가 붙으면 공시 2건이 병합 경로에서는 안 타는
  // LLM 호출·최대 30초 지연을 다시 짊어진다.
  //
  // 뉴스와 공시는 따로 묶는다(그룹 자체는 나눈다) — 한 메시지에 섞으면 병합
  // 헤더("공시 N건"/"뉴스 N건")가 둘 중 하나로 거짓말을 하게 되고, formatMerged
  // 는 뉴스에 없는 subject 필드를 읽는다. 그룹 순서는 critical과 같은 이유로
  // 공시가 먼저다.
  const merge = others.length >= MERGE_THRESHOLD
  const newsOthers = others.filter(isNews)
  const dartOthers = others.filter((i) => !isNews(i))
  for (const [group, fmt] of [
    [dartOthers, formatMerged] as const,
    [newsOthers, formatNewsMerged] as const,
  ]) {
    if (group.length === 0) continue
    if (merge) {
      // MAX_MERGED_CHARS를 넘기 전까지만 배치에 담는다 — 텔레그램 4096자 한도를 넘기면
      // 배치 전체가 거부되어 안의 항목이 모두 같이 죽는다. 담기지 못한 항목은 아무 store
      // 호출도 받지 않고 pending으로 남아 다음 사이클에 다시 claim된다 — 유실되지 않는다.
      const batch: PendingOutbox[] = []
      for (const item of group) {
        const next = [...batch, item]
        if (fmt(next.map((i) => ({ event: i.event, tier: i.tier }))).length > MAX_MERGED_CHARS) break
        batch.push(item)
      }
      const text = fmt(batch.map((i) => ({ event: i.event, tier: i.tier })))
      const res = await deps.notifier.send(text)
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

  return stats
}

async function sendOne(
  deps: DispatchDeps, item: PendingOutbox, text: string, now: Date, stats: DispatchStats,
): Promise<void> {
  const res = await deps.notifier.send(text)
  await applyResult(deps, item, res, now, stats)
}

async function applyResult(
  deps: DispatchDeps,
  item: PendingOutbox,
  res: Awaited<ReturnType<Notifier['send']>>,
  now: Date,
  stats: DispatchStats,
): Promise<void> {
  // 발송은 at-least-once다. 하나의 send() 호출이 병합 배치라면 N개 항목을 대표한다 —
  // 텔레그램이 메시지를 실제로 받았는데 우리가 그 응답만 못 받으면, 우리는 실패로 보고
  // N개 전부를 재시도해 중복 발송할 수 있다. 텔레그램 Bot API에는 idempotency key가
  // 없어 이 경로를 원천적으로 없앨 수는 없다 — "확인된 성공에만 markSent" 는 의도된
  // 선택이다: 알림 서비스에서는 중복이 누락보다 낫다.
  if (res.ok) {
    await deps.store.markSent(item.id)
    stats.sent += 1
    return
  }

  // 우리가 스스로 조절해서 안 보낸 것은 실패가 아니다 — 시도 횟수를 소비하면
  // 버스트 때 자가 스로틀링만으로 재시도 예산이 바닥나 정상 알림이 버려진다.
  const throttled = res.error === LOCAL_RATE_LIMIT
  const attempts = throttled ? item.attempts : item.attempts + 1

  if (!throttled && attempts >= MAX_ATTEMPTS) {
    await deps.store.markDead(item.id, res.error)
    stats.dead += 1
    return
  }

  // 429의 retry_after는 추측하지 않고 그대로 따른다
  const next = res.retryAfterMs !== null
    ? new Date(now.getTime() + res.retryAfterMs)
    : nextAttemptAt(item.attempts, now)

  await deps.store.markFailed(item.id, res.error, next, attempts)
  stats.failed += 1
}
