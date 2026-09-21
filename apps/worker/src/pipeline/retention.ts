import { kstDateString } from '../core/budget.js'
import { retentionCutoff } from '../core/retention.js'
import type { EventStore } from '../ports/store.js'

/** cycle.ts 의 CycleLogger 와 구조적으로 호환된다 — 순환 import 를 피하려고 여기서 따로
 *  정의한다. digest.ts 가 DigestLogger 를 같은 이유로 따로 두고 있다. */
export type RetentionLogger = {
  info(obj: Record<string, unknown> | string, msg?: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

export type RetentionDeps = { store: EventStore; log: RetentionLogger }

/**
 * 하루 한 번 오래된 행을 지운다. 다이제스트 따라잡기와 같은 자리에서, KST 날짜가
 * 바뀔 때 실행한다.
 *
 * 실패해도 던지지 않는다 — 정리는 수집·발송보다 덜 급하다. 여기서 던지면 사이클
 * catch 로 가 서킷 브레이커가 발동하고, 디스크 정리 실패 때문에 알림 폴링 주기가
 * 늘어나거나 멈춘다. 대신 날짜를 넘기지 않아 다음 사이클이 다시 시도한다.
 */
export async function runRetention(
  deps: RetentionDeps, lastPruneDate: string, now: Date,
): Promise<string> {
  const today = kstDateString(now)
  // `===` 로 두면 안 된다: 시계 스큐나 오래된 상태로 재시작해 lastPruneDate 가
  // 현재보다 앞서 있으면(예: NTP 보정이 시계를 KST 자정 너머로 되돌리는 경우)
  // 조건이 영원히 거짓이 되지 않아 사이클마다 전체 스윕을 반복한다 — 하루 한 번만
  // 돌게 하려고 이 가드를 두는 것 자체가 무의미해진다(digest.ts 의 catchUpDigests
  // 와 같은 이유). ISO 날짜 문자열은 사전순 비교가 날짜 순서와 일치하므로 `>=` 로
  // 비교하면 lastPruneDate 가 같거나 앞선 경우 모두 즉시 종료된다.
  if (lastPruneDate >= today) return lastPruneDate

  try {
    const cutoff = retentionCutoff(now)
    const { events, outbox, pinned } = await deps.store.pruneOlderThan(cutoff)
    // 세 값을 모두 남긴다. pinned 는 cutoff 보다 오래됐지만 아직 pending outbox 가
    // 물고 있어 이번엔 못 지운 이벤트 수다(ports/store.ts 참고) — "지운 게 0건"과
    // "지울 게 없어서 0건"을 가르는 유일한 신호이므로, 이 로그 줄이 빠지면 pinned
    // 가 며칠째 안 줄어도 아무도 알아챌 방법이 없다.
    deps.log.info({ cutoff: cutoff.toISOString(), events, outbox, pinned }, 'retention pruned')
    return today
  } catch (err) {
    deps.log.error({ err }, 'retention failed — will retry next cycle')
    return lastPruneDate
  }
}
