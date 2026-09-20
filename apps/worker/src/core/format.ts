import type { NormalizedEvent, Tier } from '@app/shared'

export const DISCLAIMER = '_정보 제공 목적이며 투자 권유가 아닙니다_'

const TIER_ICON: Record<Tier, string> = {
  critical: '🔴',
  high: '🟠',
  normal: '⚪',
}

/** 텔레그램 MarkdownV2 예약문자 전체. 하나라도 빠지면 메시지가 깨진다. */
const RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g

export function escapeMarkdownV2(s: string): string {
  return s.replace(RESERVED, (c) => `\\${c}`)
}

function subjectLine(e: NormalizedEvent): string {
  const name = escapeMarkdownV2(e.subject?.name ?? '알 수 없음')
  const ticker = e.subject?.ticker
  return ticker ? `*${name}* \\(${escapeMarkdownV2(ticker)}\\)` : `*${name}*`
}

export function formatEvent(e: NormalizedEvent, tier: Tier, summary?: string): string {
  const lines = [
    `${TIER_ICON[tier]} ${subjectLine(e)}`,
    escapeMarkdownV2(e.title),
  ]
  if (summary) lines.push('', escapeMarkdownV2(summary))
  lines.push('', escapeMarkdownV2(e.url), '', DISCLAIMER)
  return lines.join('\n')
}

export function formatMerged(
  items: ReadonlyArray<{ event: NormalizedEvent; tier: Tier }>,
): string {
  const head = `📢 공시 ${items.length}건`
  const body = items.map(({ event, tier }) =>
    `${TIER_ICON[tier]} ${subjectLine(event)} — ${escapeMarkdownV2(event.title)}\n${escapeMarkdownV2(event.url)}`,
  )
  return [head, '', ...body, '', DISCLAIMER].join('\n')
}

const TIER_MARK: Record<Tier, string> = { critical: '🔴', high: '🟠', normal: '🔵' }

/**
 * 뉴스 알림 포맷. 제목·매체·링크만 담는다.
 *
 * 담지 않는 것들이 중요하다 — RSS `description` 원문은 저작권상 재배포할 수 없고,
 * 영향 판정(어느 종목·업종에 어떻게)은 유사투자자문에 해당한다. tier 는 고르는 데만
 * 쓰고 방향(호재/악재)을 뜻하지 않는다. 스펙 §7.
 */
export function formatNewsEvent(e: NormalizedEvent, tier: Tier): string {
  const raw = e.raw as { press?: string } | null
  const press = typeof raw?.press === 'string' ? raw.press : null
  const lines = [
    `${TIER_MARK[tier]} *뉴스*`,
    escapeMarkdownV2(e.title),
  ]
  if (press) lines.push(`출처: ${escapeMarkdownV2(press)}`)
  lines.push(escapeMarkdownV2(e.url), '', DISCLAIMER)
  return lines.join('\n')
}

/** 뉴스 병합. formatMerged 를 쓰면 subjectLine 이 subject 없는 뉴스에서 undefined 를 찍는다. */
export function formatNewsMerged(
  items: ReadonlyArray<{ event: NormalizedEvent; tier: Tier }>,
): string {
  const head = `📰 뉴스 ${items.length}건`
  const body = items.map(({ event, tier }) => {
    const raw = event.raw as { press?: string } | null
    const press = typeof raw?.press === 'string' ? `\\[${escapeMarkdownV2(raw.press)}\\] ` : ''
    return `${TIER_MARK[tier]} ${press}${escapeMarkdownV2(event.title)}\n${escapeMarkdownV2(event.url)}`
  })
  return [head, '', ...body, '', DISCLAIMER].join('\n')
}
