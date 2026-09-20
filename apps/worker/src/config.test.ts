import { describe, it, expect } from 'vitest'
import { loadConfig } from './config.js'

const valid = {
  DATABASE_URL: 'postgres://localhost/app',
  DART_API_KEY: 'k'.repeat(40),
  TELEGRAM_BOT_TOKEN: 't',
  TELEGRAM_CHAT_ID: '-100',
  LLM_API_KEY: 'l',
}

describe('loadConfig', () => {
  it('필수 값이 모두 있으면 파싱한다', () => {
    const c = loadConfig(valid)
    expect(c.dartApiKey).toBe('k'.repeat(40))
    expect(c.telegram.chatId).toBe('-100')
  })

  it('필수 값이 빠지면 어떤 키인지 알려주며 던진다', () => {
    const { DART_API_KEY, ...rest } = valid
    expect(() => loadConfig(rest)).toThrow(/DART_API_KEY/)
  })

  it('DART 키는 40자여야 한다', () => {
    expect(() => loadConfig({ ...valid, DART_API_KEY: 'short' })).toThrow(/DART_API_KEY/)
  })

  it('heartbeat URL은 선택이며 없으면 null이다', () => {
    expect(loadConfig(valid).heartbeatUrl).toBeNull()
  })

  it('heartbeat URL이 있으면 담는다', () => {
    expect(loadConfig({ ...valid, HEARTBEAT_URL: 'https://hc.test/x' }).heartbeatUrl)
      .toBe('https://hc.test/x')
  })
})

describe('loadConfig — DART_DAILY_LIMIT (계정마다 발급된 한도가 다를 수 있다)', () => {
  it('설정하지 않으면 OpenDART 문서상 기본값(20,000)을 쓴다', () => {
    expect(loadConfig(valid).dartDailyLimit).toBe(20_000)
  })

  it('설정하면 그 값을 숫자로 담는다', () => {
    expect(loadConfig({ ...valid, DART_DAILY_LIMIT: '40000' }).dartDailyLimit).toBe(40_000)
  })

  it('0은 거부한다', () => {
    expect(() => loadConfig({ ...valid, DART_DAILY_LIMIT: '0' })).toThrow(/DART_DAILY_LIMIT/)
  })

  it('음수는 거부한다', () => {
    expect(() => loadConfig({ ...valid, DART_DAILY_LIMIT: '-1' })).toThrow(/DART_DAILY_LIMIT/)
  })

  it('숫자가 아니면 거부한다', () => {
    expect(() => loadConfig({ ...valid, DART_DAILY_LIMIT: 'abc' })).toThrow(/DART_DAILY_LIMIT/)
  })
})

describe('loadConfig — 운영자 채널', () => {
  it('설정하지 않으면 null이다 — 오늘의 동작(단일 채널)이 그대로 유지된다', () => {
    expect(loadConfig(valid).operatorChatId).toBeNull()
  })

  it('설정하면 담는다 — 다이제스트와 장애 알림이 이쪽으로 빠진다', () => {
    expect(loadConfig({ ...valid, TELEGRAM_OPERATOR_CHAT_ID: '-200' }).operatorChatId)
      .toBe('-200')
  })

  it('구독자 채널과 별개의 값이다 — 같은 값으로 합쳐지지 않는다', () => {
    const c = loadConfig({ ...valid, TELEGRAM_OPERATOR_CHAT_ID: '-200' })
    expect(c.telegram.chatId).toBe('-100')
    expect(c.operatorChatId).toBe('-200')
  })
})

// --------------------------------------------------------------------------
// `--env-file`(Node, Docker 공통)은 `KEY=`를 빈 문자열로 파싱한다 — 키가 없는
// 것과는 다른 상태다. .env.example과 docs/deploy-oci.md는 선택/기본값이 있는
// 변수를 "비워도 된다"고 안내하지만, 예전 스키마는 undefined에서만 optional/
// default를 발동시켜 빈 문자열을 "설정됨"으로 취급했다 — 그 결과가 변수마다
// 달랐다(TELEGRAM_OPERATOR_CHAT_ID는 시작 크래시, LLM_MODEL/LLM_ENDPOINT는
// 기본값 미적용, DART_DAILY_LIMIT는 크래시, HEARTBEAT_URL만 우연히 무해했다).
// 아래는 다섯 변수 모두 "빈 문자열"과 "공백만"이 "키 없음"과 동일하게
// 동작함을 고정한다.
// --------------------------------------------------------------------------
describe('loadConfig — 빈 값·공백은 "키 없음"과 동일하게 취급한다 (--env-file이 KEY= 를 빈 문자열로 만들기 때문)', () => {
  describe('TELEGRAM_OPERATOR_CHAT_ID', () => {
    it('빈 문자열은 없음과 동일하다 — null (예전엔 여기서 ZodError로 죽었다)', () => {
      expect(loadConfig({ ...valid, TELEGRAM_OPERATOR_CHAT_ID: '' }).operatorChatId).toBeNull()
    })

    it('공백만 있으면 없음과 동일하다 — null', () => {
      expect(loadConfig({ ...valid, TELEGRAM_OPERATOR_CHAT_ID: '   ' }).operatorChatId).toBeNull()
    })

    it('키가 아예 없으면 null이다 (기존 동작 유지)', () => {
      expect(loadConfig(valid).operatorChatId).toBeNull()
    })

    it('실제 값이 있으면 그대로 담는다 (기존 동작 유지)', () => {
      expect(loadConfig({ ...valid, TELEGRAM_OPERATOR_CHAT_ID: '-200' }).operatorChatId).toBe('-200')
    })
  })

  describe('HEARTBEAT_URL', () => {
    it('빈 문자열은 없음과 동일하다 — null (예전엔 "" 로 남아 우연히만 무해했다)', () => {
      expect(loadConfig({ ...valid, HEARTBEAT_URL: '' }).heartbeatUrl).toBeNull()
    })

    it('공백만 있으면 없음과 동일하다 — null', () => {
      expect(loadConfig({ ...valid, HEARTBEAT_URL: '   ' }).heartbeatUrl).toBeNull()
    })

    it('키가 아예 없으면 null이다 (기존 동작 유지)', () => {
      expect(loadConfig(valid).heartbeatUrl).toBeNull()
    })

    it('실제 값이 있으면 그대로 담는다 (기존 동작 유지)', () => {
      expect(loadConfig({ ...valid, HEARTBEAT_URL: 'https://hc.test/x' }).heartbeatUrl)
        .toBe('https://hc.test/x')
    })
  })

  describe('LLM_MODEL', () => {
    const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

    it('빈 문자열은 없음과 동일하다 — 기본값이 적용된다 (예전엔 기본값을 건너뛰고 "" 가 됐다)', () => {
      expect(loadConfig({ ...valid, LLM_MODEL: '' }).llm.model).toBe(DEFAULT_MODEL)
    })

    it('공백만 있으면 없음과 동일하다 — 기본값이 적용된다', () => {
      expect(loadConfig({ ...valid, LLM_MODEL: '   ' }).llm.model).toBe(DEFAULT_MODEL)
    })

    it('키가 아예 없으면 기본값이다 (기존 동작 유지)', () => {
      expect(loadConfig(valid).llm.model).toBe(DEFAULT_MODEL)
    })

    it('실제 값이 있으면 그대로 담는다 (기존 동작 유지)', () => {
      expect(loadConfig({ ...valid, LLM_MODEL: 'claude-opus-4' }).llm.model).toBe('claude-opus-4')
    })
  })

  describe('LLM_ENDPOINT', () => {
    const DEFAULT_ENDPOINT = 'https://api.anthropic.com/v1/messages'

    it('빈 문자열은 없음과 동일하다 — 기본값이 적용된다 (예전엔 "" 가 되어 요약이 조용히 실패했다)', () => {
      expect(loadConfig({ ...valid, LLM_ENDPOINT: '' }).llm.endpoint).toBe(DEFAULT_ENDPOINT)
    })

    it('공백만 있으면 없음과 동일하다 — 기본값이 적용된다', () => {
      expect(loadConfig({ ...valid, LLM_ENDPOINT: '   ' }).llm.endpoint).toBe(DEFAULT_ENDPOINT)
    })

    it('키가 아예 없으면 기본값이다 (기존 동작 유지)', () => {
      expect(loadConfig(valid).llm.endpoint).toBe(DEFAULT_ENDPOINT)
    })

    it('실제 값이 있으면 그대로 담는다 (기존 동작 유지)', () => {
      expect(loadConfig({ ...valid, LLM_ENDPOINT: 'https://custom.example/v1' }).llm.endpoint)
        .toBe('https://custom.example/v1')
    })
  })

  describe('DART_DAILY_LIMIT', () => {
    it('빈 문자열은 없음과 동일하다 — 기본값 20,000 (예전엔 여기서 ZodError로 죽었다)', () => {
      expect(loadConfig({ ...valid, DART_DAILY_LIMIT: '' }).dartDailyLimit).toBe(20_000)
    })

    it('공백만 있으면 없음과 동일하다 — 기본값 20,000', () => {
      expect(loadConfig({ ...valid, DART_DAILY_LIMIT: '   ' }).dartDailyLimit).toBe(20_000)
    })

    it('키가 아예 없으면 기본값이다 (기존 동작 유지)', () => {
      expect(loadConfig(valid).dartDailyLimit).toBe(20_000)
    })

    it('실제 값이 있으면 그대로 담는다 (기존 동작 유지)', () => {
      expect(loadConfig({ ...valid, DART_DAILY_LIMIT: '40000' }).dartDailyLimit).toBe(40_000)
    })
  })

  it('.env.example 그대로 — 모든 선택 키가 존재하되 비어 있으면 그래도 파싱된다 (실제로 깨졌던 그 형태)', () => {
    // apps/worker/.env.example 의 형태를 그대로 옮긴 것 — 필수 키만 실값, 선택 키는
    // 전부 "키는 있고 값은 빈 문자열"이다. --env-file 로 읽은 실제 .env 가 항상
    // 이 모양이 된다.
    const envExampleShaped = {
      DATABASE_URL: valid.DATABASE_URL,
      DART_API_KEY: valid.DART_API_KEY,
      TELEGRAM_BOT_TOKEN: valid.TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID: valid.TELEGRAM_CHAT_ID,
      TELEGRAM_OPERATOR_CHAT_ID: '',
      LLM_API_KEY: valid.LLM_API_KEY,
      HEARTBEAT_URL: '',
      DART_DAILY_LIMIT: '',
    }

    const c = loadConfig(envExampleShaped)

    expect(c.operatorChatId).toBeNull()
    expect(c.heartbeatUrl).toBeNull()
    expect(c.dartDailyLimit).toBe(20_000)
    expect(c.llm.model).toBe('claude-haiku-4-5-20251001')
    expect(c.llm.endpoint).toBe('https://api.anthropic.com/v1/messages')
  })
})

// --------------------------------------------------------------------------
// 전처리는 선택/기본값 필드에만 적용된다. 필수 필드는 여전히 엄격해야 한다 —
// 빈 문자열이 "없음"으로 접혀 통과해 버리면 필수값 누락을 조용히 숨기게 된다.
// --------------------------------------------------------------------------
describe('loadConfig — NEWS_ENABLED / NEWS_INTERVAL_MS (배포와 활성화를 분리한다)', () => {
  it('NEWS_ENABLED 기본값은 false — 배포와 활성화를 분리한다', () => {
    expect(loadConfig(valid).newsEnabled).toBe(false)
  })

  it('NEWS_ENABLED=true면 켜진다', () => {
    expect(loadConfig({ ...valid, NEWS_ENABLED: 'true' }).newsEnabled).toBe(true)
  })

  it('NEWS_INTERVAL_MS 기본값은 60초 — 조건부 요청이 거의 안 먹어 매번 전문을 받는다', () => {
    expect(loadConfig(valid).newsIntervalMs).toBe(60_000)
  })

  it('빈 문자열은 기본값으로 접힌다', () => {
    expect(loadConfig({ ...valid, NEWS_INTERVAL_MS: '' }).newsIntervalMs).toBe(60_000)
  })
})

describe('loadConfig — 필수 값은 빈 문자열이어도 여전히 거부한다 (전처리로 약화되지 않는다)', () => {
  it('DATABASE_URL 빈 문자열은 거부한다', () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: '' })).toThrow(/DATABASE_URL/)
  })

  it('DART_API_KEY 빈 문자열은 거부한다 (기존 메시지 유지)', () => {
    expect(() => loadConfig({ ...valid, DART_API_KEY: '' })).toThrow(/DART_API_KEY는 40자여야 합니다/)
  })

  it('TELEGRAM_BOT_TOKEN 빈 문자열은 거부한다', () => {
    expect(() => loadConfig({ ...valid, TELEGRAM_BOT_TOKEN: '' })).toThrow(/TELEGRAM_BOT_TOKEN/)
  })

  it('TELEGRAM_CHAT_ID 빈 문자열은 거부한다', () => {
    expect(() => loadConfig({ ...valid, TELEGRAM_CHAT_ID: '' })).toThrow(/TELEGRAM_CHAT_ID/)
  })

  it('LLM_API_KEY 빈 문자열은 거부한다', () => {
    expect(() => loadConfig({ ...valid, LLM_API_KEY: '' })).toThrow(/LLM_API_KEY/)
  })
})
