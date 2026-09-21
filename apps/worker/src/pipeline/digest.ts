import { nextKstDate } from '../core/budget.js'
import { formatDigest, MAX_DIGEST_ATTEMPTS } from '../core/digest.js'
import type { Notifier } from '../ports/notifier.js'
import type { EventStore } from '../ports/store.js'

/** cycle.ts 의 CycleLogger 와 구조적으로 호환된다 — 순환 import 를 피하려고 여기서 따로 정의한다. */
export type DigestLogger = {
  error(obj: Record<string, unknown>, msg: string): void
}

export type DigestDeps = {
  store: EventStore
  notifier: Notifier
  sourceId: string
  log: DigestLogger
  /** 계정에 발급된 일일 한도. 다이제스트의 API 분모로 그대로 노출된다. */
  dailyLimit: number
}

/**
 * 재시도 중인 "그 날짜"에 대한 연속 실패 횟수. 한 번에 재시도되는 날짜는 항상
 * lastDigestDate 하나뿐이므로(오래된 날짜부터 순서대로 처리) 맵이 아니라 이
 * 한 쌍이면 충분하다. lastDigestDate 와 같은 자리(CycleState)에 두어 사이클을
 * 넘어 살아남게 한다 — 그래야 "매 사이클 재시도"가 실제로 예산을 소진한다.
 */
export type DigestAttempt = { date: string; attempts: number }

export type CatchUpResult = {
  lastDigestDate: string
  digestAttempt: DigestAttempt | null
}

/** 발송에 성공했는지 반환한다. 결과를 버리면 실패를 알 방법이 없다. */
export async function runDigest(deps: DigestDeps, kstDate: string): Promise<boolean> {
  // sourceId 는 집계 전체에 걸린다. 분모(API 사용량)에만 쓰면 뉴스를 켜는 날
  // 공시 다이제스트가 뉴스 통계까지 함께 세게 된다 — ports/store.ts 주석 참고.
  const agg = await deps.store.digestFor(kstDate, deps.sourceId)
  const apiCalls = await deps.store.getApiUsage(deps.sourceId, kstDate)

  const res = await deps.notifier.send(formatDigest({
    kstDate,
    sent: agg.sent,
    dead: agg.dead,
    apiCalls,
    dailyLimit: deps.dailyLimit,
    missedCandidates: agg.missedCandidates,
    errorCounts: agg.errorCounts,
    missedTotal: agg.missedTotal,
  }))

  return res.ok
}

/**
 * lastDigestDate 부터 currentKstDate 직전까지, 밀린 날짜를 하루씩 모두 보낸다.
 * `lastDigestDate = currentKstDate` 로 건너뛰면 장애가 자정을 두 번 넘겼을 때
 * 중간 날의 다이제스트가 영영 사라진다 — 다이제스트는 운영자의 유일한 사후
 * 감사 기록이므로 누락되면 안 된다. 반환값은 다음 lastDigestDate(= currentKstDate,
 * 단 lastDigestDate 가 이미 그 이상이면 원래 값 그대로)다.
 *
 * `!==` 로 두면 안 된다: 시계 스큐나 오래된 상태로 재시작해 lastDigestDate 가
 * 현재보다 앞서 있으면 조건이 영원히 거짓이 되지 않아 다이제스트를 무한 발송한다.
 * ISO 날짜 문자열은 사전순 비교가 날짜 순서와 일치하므로 `<` 로 비교하면
 * lastDigestDate 가 같거나 앞선 경우 즉시 종료된다.
 *
 * `digestAttempt` 는 지금 막혀 있는 날짜의 연속 실패 횟수다. MAX_DIGEST_ATTEMPTS 를
 * 다 쓰면 그 날짜를 포기하고 전진한다 — outbox 의 MAX_ATTEMPTS·markDead 와 같은
 * 모양이다. 포기하지 않으면 발송 불가능한 날짜(운영자 chat id 오류, 길이 상한을
 * 넘는 본문)에 매 사이클 영원히 멈춰 운영자 채널의 레이트리밋 예산을 태우고,
 * 같은 토큰 버킷을 쓰는 연속 실패 알림까지 지연시킨다.
 */
export async function catchUpDigests(
  deps: DigestDeps,
  lastDigestDate: string,
  currentKstDate: string,
  digestAttempt: DigestAttempt | null,
): Promise<CatchUpResult> {
  let date = lastDigestDate
  let attempt = digestAttempt
  while (date < currentKstDate) {
    // 발송 결과를 확인하지 않고 날짜를 전진시키면, 한도 초과·429·네트워크 오류로
    // 거부된 다이제스트가 조용히 사라진다. 그날의 기록은 두 번 다시 나오지 않는다.
    if (await runDigest(deps, date)) {
      date = nextKstDate(date)
      attempt = null
      continue
    }

    // 실패하면 우선 그대로 두고 빠져나가 다음 사이클이 같은 날짜를 재시도한다
    // (자체 레이트 리밋에 걸린 경우도 여기로 온다 — 다음 사이클에 자연히 풀린다).
    // 단, 이 날짜에 대한 재시도가 한도에 닿았으면 포기하고 전진한다.
    const attempts = (attempt !== null && attempt.date === date ? attempt.attempts : 0) + 1

    if (attempts >= MAX_DIGEST_ATTEMPTS) {
      deps.log.error({ date, attempts }, 'digest permanently unsendable — giving up')
      // 포기 통지 자체가 루프를 막으면 안 된다 — 이 발송이 실패해도 조용히 버린다.
      await deps.notifier.send(
        `⚠️ ${date} 다이제스트를 ${MAX_DIGEST_ATTEMPTS}회 재시도해도 보내지 못해 포기합니다.`,
      ).catch(() => {})
      return { lastDigestDate: nextKstDate(date), digestAttempt: null }
    }

    return { lastDigestDate: date, digestAttempt: { date, attempts } }
  }
  return { lastDigestDate: date, digestAttempt: attempt }
}
