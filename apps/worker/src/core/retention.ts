/**
 * events 와 종결된 outbox 행의 보관 기간.
 *
 * 90일인 이유는 저장량이다(스펙 §6.2). 보관 정책 없이 뉴스를 쌓으면 1년에
 * 742MB 로 Supabase 무료 티어 500MB 를 넘긴다. 90일이면 183MB 에서 평형을
 * 이루고 더 늘지 않는다.
 *
 * 튜닝에는 90일이면 충분하다 — 1단계 필터를 27.9건/일에서 58.1건/일로 만든
 * 분석이 4주치 데이터로 이루어졌다.
 */
export const RETENTION_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000

/** 이 시각보다 오래된 행이 삭제 대상이다. core 는 순수해야 하므로 now 를 받는다. */
export function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - RETENTION_DAYS * DAY_MS)
}
