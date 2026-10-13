import type { NormalizedEvent } from '@app/shared'
import { decideMacro, MACRO_PARAMS, type MacroCandidate, type MacroParams } from '../core/news/cluster.js'
import { isBreaking } from '../core/news/macro.js'
import { expiresAt } from '../core/policy.js'
import type { EventStore } from '../ports/store.js'

export type MacroLogger = {
  info(obj: Record<string, unknown>, msg: string): void
}

export type MacroDeps = {
  store: Pick<EventStore, 'macroCandidates' | 'recentMacroFires' | 'recordMacroFire'>
  log: MacroLogger
}

export type MacroStats = { sent: number; capped: number }

/** 거시 후보를 내는 소스. 뉴스 어댑터의 id 이고, store.macroCandidates 도 이 소스만 본다. */
export const MACRO_SOURCE_ID = 'news'

/** 거시 알림의 급(tier). 급은 긴급도이지 방향이 아니다 — 호재/악재를 뜻하지 않는다. */
export const MACRO_TIER = 'high' as const

/** 발송 메시지가 읽는 거시 표시. 매체 수만 싣는다 — 해석(어느 업종에 영향)은 싣지 않는다(스펙 §7). */
export type MacroMeta = { presses: number }

const RULE_PREFIX = 'macro:'

/**
 * 거시 트랙 한 차례. 후보를 모아 core 의 decideMacro 로 결정하고, 결정마다 발화를
 * 기록한다(sent 면 같은 트랜잭션에서 outbox 예약).
 *
 * `floor` 는 뉴스 소스가 콜드 스타트로 백로그를 기록한 시각이다. 그 사이클에 기록된
 * 행은 first_seen_at 이 전부 그 시각이라, 몇 시간·며칠 전 기사들이 "방금 여러 매체가
 * 동시에 썼다"로 보인다 — 재기동할 때마다 옛 사건이 알림으로 나간다. floor 와 같은
 * 시각은 후보에서 뺀다(store.macroCandidates 의 `>`).
 *
 * 발송은 하지 않는다. outbox 에 넣으면 같은 사이클의 runDispatch 가 보낸다.
 */
export async function runMacro(
  deps: MacroDeps, now: Date, floor: Date, params: MacroParams = MACRO_PARAMS,
): Promise<MacroStats> {
  const since = new Date(Math.max(now.getTime() - params.windowMs, floor.getTime()))
  const rows = await deps.store.macroCandidates(since)
  const candidates: MacroCandidate[] = rows
    .filter((r) => r.rule.startsWith(RULE_PREFIX))
    .map((r) => ({
      eventId: r.eventId,
      key: r.rule.slice(RULE_PREFIX.length),
      press: pressOf(r.event),
      breaking: isBreaking(r.event.title),
      event: r.event,
    }))

  // 쿨다운과 시간당 상한 중 긴 쪽만큼 이력을 읽는다.
  const historyMs = Math.max(params.cooldownMs, 60 * 60_000)
  const fires = await deps.store.recentMacroFires(new Date(now.getTime() - historyMs))

  const stats: MacroStats = { sent: 0, capped: 0 }
  for (const d of decideMacro(candidates, fires, now, params)) {
    const rep = d.representative
    const enqueue = d.outcome === 'sent'
      ? { tier: MACRO_TIER, payload: withMacroMeta(rep.event, { presses: d.presses.length }), expiresAt: expiresAt(MACRO_TIER, now) }
      : null
    await deps.store.recordMacroFire(
      { key: d.key, firedAt: now, eventId: rep.eventId, presses: d.presses.length, trigger: d.trigger, outcome: d.outcome },
      enqueue,
    )
    stats[d.outcome] += 1
    // 성공 경로도 남긴다 — 어떤 거시 알림이 왜(속보인가, 매체 수인가) 나갔는지는
    // 튜닝의 유일한 근거다. capped 는 특히 남겨야 한다(버린 것을 센다).
    deps.log.info(
      { key: d.key, trigger: d.trigger, presses: d.presses, outcome: d.outcome, title: rep.event.title },
      'macro fire',
    )
  }
  return stats
}

function pressOf(event: NormalizedEvent): string {
  const press = (event.raw as { press?: unknown } | null)?.press
  // 매체를 모르는 기사들은 한 곳으로 센다. 기사마다 다른 값으로 두면 매체 수가
  // 부풀어 오발화한다 — 놓치는 쪽이 잘못 보내는 쪽보다 싸다. 뉴스 어댑터는 항상
  // press 를 싣으므로 정상 경로에서는 오지 않는다.
  return typeof press === 'string' && press !== '' ? press : '알 수 없음'
}

function withMacroMeta(event: NormalizedEvent, macro: MacroMeta): NormalizedEvent {
  const raw = (event.raw && typeof event.raw === 'object') ? event.raw as Record<string, unknown> : {}
  return { ...event, raw: { ...raw, macro } }
}
