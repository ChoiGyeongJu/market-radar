import type { NormalizedEvent } from '@app/shared'

export type EventSource = {
  readonly id: string
  /**
   * 최신 이벤트를 가져온다. 호출 1회는 "이 소스를 한 번 들여다본다"는 뜻일 뿐,
   * **상위 API 호출 1회를 뜻하지 않는다** — RSS 어댑터는 한 번의 호출에서 구독
   * 피드 수만큼 요청을 보낸다. 일일 한도에 어떻게 세는지는 소스가 아니라
   * pipeline/ingest.ts 의 SourcePlan.countsAgainstApiBudget 이 정한다.
   */
  fetchLatest(now: Date): Promise<NormalizedEvent[]>
}
