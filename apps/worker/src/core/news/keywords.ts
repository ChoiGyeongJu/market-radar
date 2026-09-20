import type { Tier } from '@app/shared'

/**
 * 뉴스용 키워드. DART 키워드셋(core/dart/keywords.ts)과 사건 종류는 같지만
 * 표기가 다르다 — DART 는 `단일판매ㆍ공급계약체결` 같은 정형 제목이고,
 * 뉴스는 `수주` / `계약 체결` / `공급 계약` 으로 흩어진다.
 *
 * 공백을 제거한 텍스트에 대해 매칭하므로 여기 항목도 공백 없이 적는다.
 */
export const NEWS_CRITICAL: readonly string[] = [
  '횡령', '배임', '압수수색', '상장폐지', '거래정지', '회생절차', '파산',
  '유상증자', '무상증자', '감자결정', '분식회계', '영업정지',
]

export const NEWS_HIGH: readonly string[] = [
  '수주', '계약체결', '공급계약', '기술수출', '인수합병', '지분인수',
  '임상3상', '임상2상', '품목허가', '특허취득', '리콜', '화재',
  '실적발표', '영업이익', '어닝쇼크', '어닝서프라이즈', '자사주매입',
]

export const NEWS_NORMAL: readonly string[] = [
  '배당', '주주총회', '신제품', '업무협약', 'MOU', '공장증설',
]

export const NEWS_TIERS: readonly { tier: Tier; words: readonly string[] }[] = [
  { tier: 'critical', words: NEWS_CRITICAL },
  { tier: 'high', words: NEWS_HIGH },
  { tier: 'normal', words: NEWS_NORMAL },
]
