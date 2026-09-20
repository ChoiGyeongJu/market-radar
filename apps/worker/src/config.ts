import { z } from 'zod'

const DART_DAILY_LIMIT_MSG = 'DART_DAILY_LIMIT는 양의 정수여야 합니다'

/**
 * Node의 `--env-file`과 `docker run --env-file`은 둘 다 `KEY=`를 빈 문자열로
 * 파싱한다 — 키가 아예 없는 것과는 다른 상태다. zod의 `.optional()`/`.default()`는
 * `undefined`에서만 발동하므로, 문서에서 "선택, 비워두면 됨"이라 안내한 값을
 * 실제로 비워두면 "존재하지만 빈 값"이 되어 스키마를 그대로 통과하거나(기본값
 * 미적용) 반대로 거부당한다(`.min(1)`). 선택/기본값이 있는 필드에 한해 파싱
 * *전에* 비어 있거나 공백만 있는 문자열을 `undefined`로 접어, 값을 아예 안 쓴
 * 것과 동일하게 만든다. 필수 필드에는 적용하지 않는다 — 빈 필수값은 지금처럼
 * 그대로 거부되어야 한다.
 */
const blankToUndefined = (val: unknown): unknown =>
  typeof val === 'string' && val.trim() === '' ? undefined : val

function optionalField<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(blankToUndefined, schema)
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DART_API_KEY: z.string().length(40, 'DART_API_KEY는 40자여야 합니다'),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  TELEGRAM_OPERATOR_CHAT_ID: optionalField(z.string().min(1).optional()),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: optionalField(z.string().default('claude-haiku-4-5-20251001')),
  LLM_ENDPOINT: optionalField(z.string().default('https://api.anthropic.com/v1/messages')),
  HEARTBEAT_URL: optionalField(z.string().optional()),
  // OpenDART 문서상 기본 한도는 계정당 20,000건/일이지만, 발급받은 한도가 이와
  // 다른 계정도 있다(OpenDART 에러 문서: "요청 제한이 다르게 설정된 경우에는
  // 이에 준하여 발생됩니다"). 기본값은 문서상 한도로 두고, 다르게 발급받은
  // 계정만 이 값을 채우면 된다.
  DART_DAILY_LIMIT: optionalField(
    z.coerce
      .number({ error: DART_DAILY_LIMIT_MSG })
      .int(DART_DAILY_LIMIT_MSG)
      .positive(DART_DAILY_LIMIT_MSG)
      .default(20_000),
  ),
  // 배포와 활성화를 분리한다. 이미지가 올라간 뒤에도 켜기 전까지 기존 동작
  // 그대로이므로, 뉴스가 채널을 뒤덮으면 이미지를 되돌리지 않고 끌 수 있다.
  NEWS_ENABLED: optionalField(z.enum(['true', 'false']).default('false')),
  // 60초. RSS 반영 지연이 중앙값 3.5분(210초)이라 폴링 주기는 반올림 오차에 가깝고,
  // 조건부 요청이 실측상 5개 중 1개에서만 먹는다(스펙 §4.3) — 나머지는 매번 전문을
  // 다시 받는다. 30초면 하루 1.2GB, 60초면 0.6GB이고 지연은 6.7%만 나빠진다.
  NEWS_INTERVAL_MS: optionalField(
    z.coerce.number().int().positive().default(60_000),
  ),
})

export type Config = {
  databaseUrl: string
  dartApiKey: string
  telegram: { token: string; chatId: string }
  /**
   * 설정되면 운영자 전용 채널. 일일 다이제스트(버려진 공시 목록·내부 카운터)와
   * 연속 실패 알림이 이쪽으로만 간다. 없으면 기존처럼 메인 채널로 간다 —
   * 비공개 채널 단계에서는 구독자가 운영자뿐이라 구분할 이유가 없기 때문이다.
   * 공개 전환 시 반드시 설정해야 한다.
   */
  operatorChatId: string | null
  llm: { apiKey: string; model: string; endpoint: string }
  heartbeatUrl: string | null
  /** 계정에 발급된 일일 호출 한도. 미설정 시 OpenDART 문서상 기본값(20,000). */
  dartDailyLimit: number
  /** 기본 false — 배포와 활성화를 분리한다. 켜기 전까지 기존 동작(DART 단일 소스) 그대로다. */
  newsEnabled: boolean
  /** RSS 폴링 주기(ms). 기본 60초. */
  newsIntervalMs: number
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.parse(env)
  return {
    databaseUrl: parsed.DATABASE_URL,
    dartApiKey: parsed.DART_API_KEY,
    telegram: { token: parsed.TELEGRAM_BOT_TOKEN, chatId: parsed.TELEGRAM_CHAT_ID },
    operatorChatId: parsed.TELEGRAM_OPERATOR_CHAT_ID ?? null,
    llm: { apiKey: parsed.LLM_API_KEY, model: parsed.LLM_MODEL, endpoint: parsed.LLM_ENDPOINT },
    heartbeatUrl: parsed.HEARTBEAT_URL ?? null,
    dartDailyLimit: parsed.DART_DAILY_LIMIT,
    newsEnabled: parsed.NEWS_ENABLED === 'true',
    newsIntervalMs: parsed.NEWS_INTERVAL_MS,
  }
}
