import { describe, it, expect } from 'vitest'
import type { NormalizedEvent } from '@app/shared'
import { escapeMarkdownV2, formatEvent, formatMerged, formatNewsEvent, formatNewsMerged, DISCLAIMER } from './format.js'

const e: NormalizedEvent = {
  sourceId: 'dart',
  externalId: '20260919000123',
  occurredAt: new Date('2026-09-18T15:00:00Z'),
  firstSeenAt: new Date('2026-09-19T06:30:00Z'),
  title: '단일판매·공급계약체결',
  url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260919000123',
  subject: { name: '샘플_전자', ticker: '005930', market: 'Y' },
  raw: {},
}

describe('escapeMarkdownV2', () => {
  it('MarkdownV2 예약문자를 전부 이스케이프한다', () => {
    expect(escapeMarkdownV2('a_b*c[d]e(f)g~h`i>j#k+l-m=n|o{p}q.r!s'))
      .toBe('a\\_b\\*c\\[d\\]e\\(f\\)g\\~h\\`i\\>j\\#k\\+l\\-m\\=n\\|o\\{p\\}q\\.r\\!s')
  })

  it('회사명의 밑줄을 깨뜨리지 않는다', () => {
    expect(escapeMarkdownV2('샘플_전자')).toBe('샘플\\_전자')
  })

  it('백슬래시 자신도 이스케이프된다', () => {
    expect(escapeMarkdownV2('\\')).toBe('\\\\')
  })
})

describe('formatEvent', () => {
  it('종목명·티커·제목·링크·고지를 담는다', () => {
    const msg = formatEvent(e, 'critical')
    expect(msg).toContain('샘플\\_전자')
    expect(msg).toContain('005930')
    expect(msg).toContain('단일판매')
    expect(msg).toContain(escapeMarkdownV2(e.url))
    expect(msg).toContain(DISCLAIMER)
  })

  it('요약이 있으면 포함한다', () => {
    expect(formatEvent(e, 'high', '계약금액 500억원')).toContain('계약금액 500억원')
  })

  it('고지 문구는 항상 붙는다', () => {
    expect(formatEvent(e, 'normal')).toContain('투자 권유가 아닙니다')
  })
})

describe('formatMerged', () => {
  it('여러 건을 한 메시지로 묶는다', () => {
    const msg = formatMerged([
      { event: e, tier: 'high' },
      { event: { ...e, externalId: '2', title: '무상증자결정' }, tier: 'high' },
    ])
    expect(msg).toContain('공시 2건')
    expect(msg).toContain('단일판매')
    expect(msg).toContain('무상증자결정')
    expect(msg).toContain(DISCLAIMER)
  })
})

describe('escape invariant — 예약문자 누락 감지', () => {
  it('예약문자를 포함한 모든 입력을 올바르게 이스케이프한다 (formatEvent)', () => {
    const msg = formatEvent(e, 'critical')

    // Company name and ticker must appear escaped (company name has _)
    const escapedName = escapeMarkdownV2(e.subject!.name)
    const escapedTicker = escapeMarkdownV2(e.subject!.ticker!)
    expect(msg).toContain(escapedName)
    expect(msg).toContain(escapedTicker)

    // URL must appear fully escaped (contains . = ? etc.)
    const escapedUrl = escapeMarkdownV2(e.url)
    expect(msg).toContain(escapedUrl)

    // Critical: verify unescaped reserved characters from URL don't appear
    // If someone removes escapeMarkdownV2(e.url), these patterns will leak through
    expect(msg).not.toContain('dart.fss.or.kr')
    expect(msg).not.toContain('rcpNo=')
    expect(msg).not.toContain('main.do')
  })

  it('병합 메시지에서 모든 URL을 이스케이프한다 (formatMerged)', () => {
    const e2: NormalizedEvent = {
      ...e,
      externalId: '20260919000456',
      url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260919000456',
      title: '무상증자결정',
    }

    const msg = formatMerged([
      { event: e, tier: 'high' },
      { event: e2, tier: 'critical' },
    ])

    // Both URLs must appear escaped
    const escapedUrl1 = escapeMarkdownV2(e.url)
    const escapedUrl2 = escapeMarkdownV2(e2.url)
    expect(msg).toContain(escapedUrl1)
    expect(msg).toContain(escapedUrl2)

    // Critical: verify unescaped reserved characters don't appear from either event
    // If someone removes escapeMarkdownV2(event.url) in formatMerged, these leak through
    expect(msg).not.toContain('rcpNo=20260919000123')
    expect(msg).not.toContain('rcpNo=20260919000456')
    expect(msg).not.toContain('main.do?')
  })
})

const newsEvent = (title: string): NormalizedEvent => ({
  sourceId: 'news', externalId: 'yna-eco:1', occurredAt: new Date('2026-09-20T09:05:00Z'),
  firstSeenAt: new Date('2026-09-20T09:10:00Z'), title,
  url: 'https://example.com/a', raw: { feedId: 'yna-eco', press: '연합뉴스' },
})

describe('formatNewsEvent', () => {
  it('제목·매체·링크를 담는다', () => {
    const s = formatNewsEvent(newsEvent('한미약품 수주 계약'), 'high')
    expect(s).toContain('한미약품 수주 계약')
    expect(s).toContain('연합뉴스')
    expect(s).toContain(escapeMarkdownV2('https://example.com/a'))
  })

  it('면책 문구를 붙인다', () => {
    expect(formatNewsEvent(newsEvent('제목'), 'high')).toContain(DISCLAIMER)
  })

  it('MarkdownV2 특수문자를 이스케이프한다', () => {
    const s = formatNewsEvent(newsEvent('한미약품 (주) 수주 - 1분기'), 'high')
    expect(s).toContain('\\(')
    expect(s).toContain('\\-')
  })

  it('press가 없으면 매체 줄을 생략한다 — 빈 라벨을 찍지 않는다', () => {
    const e = { ...newsEvent('제목'), raw: {} }
    expect(formatNewsEvent(e, 'high')).not.toContain('출처')
  })

  it('subject가 없어도 undefined가 새지 않는다', () => {
    expect(formatNewsEvent(newsEvent('제목'), 'high')).not.toContain('undefined')
  })
})

describe('formatNewsMerged', () => {
  it('헤더가 공시가 아니라 뉴스다', () => {
    const s = formatNewsMerged([{ event: newsEvent('가'), tier: 'high' }])
    expect(s).toContain('뉴스 1건')
    expect(s).not.toContain('공시')
  })

  it('subject가 없어도 undefined가 새지 않는다 — formatMerged 를 그대로 쓰면 터지는 지점', () => {
    const s = formatNewsMerged([
      { event: newsEvent('가'), tier: 'high' },
      { event: newsEvent('나'), tier: 'normal' },
    ])
    expect(s).not.toContain('undefined')
    expect(s).toContain('연합뉴스')
  })
})

describe('reserved character invariant — 뉴스 메시지의 MarkdownV2 유효성', () => {
  const RESERVED_CHARS = '_*[]()~`>#+\\-=|{}.!'

  // Telegram MarkdownV2에서 예약문자가 이스케이프되지 않으면 400 에러로 메시지 손실.
  // 의도적 마크업 외의 모든 예약문자는 반드시 이스케이프되어야 한다.
  function assertNoUnescapedReserved(output: string, intentionalMarkup: string[]): void {
    // 의도적 마크업이 위치한 범위를 먼저 표시
    const intentionalRanges: [number, number][] = []
    for (const markup of intentionalMarkup) {
      let idx = 0
      while ((idx = output.indexOf(markup, idx)) !== -1) {
        intentionalRanges.push([idx, idx + markup.length])
        idx += markup.length
      }
    }

    let i = 0
    while (i < output.length) {
      const char = output.charAt(i)

      // 백슬래시-예약문자 시퀀스는 정상적인 이스케이프
      if (char === '\\' && i + 1 < output.length && RESERVED_CHARS.includes(output.charAt(i + 1))) {
        i += 2
        continue
      }

      if (!RESERVED_CHARS.includes(char)) {
        i++
        continue
      }

      // 이 위치가 의도적 마크업 범위에 포함되는지 확인
      let isIntentional = false
      for (const [start, end] of intentionalRanges) {
        if (i >= start && i < end) {
          isIntentional = true
          break
        }
      }

      if (!isIntentional) {
        const context = output.substring(Math.max(0, i - 20), i + 20)
        throw new Error(
          `예약문자 미이스케이프: '${char}' at position ${i} in: "${context}"`
        )
      }

      i++
    }
  }

  it('formatNewsEvent의 모든 예약문자가 이스케이프되거나 의도적 마크업이다', () => {
    const challenging = newsEvent('한미약품 [주] (주) 수주.계약 - 1분기!테스트')
    const s = formatNewsEvent(challenging, 'high')

    // 의도적 마크업: *뉴스*, DISCLAIMER (이미 _ 포함)
    const intentional = ['*뉴스*', DISCLAIMER]
    assertNoUnescapedReserved(s, intentional)
  })

  it('formatNewsMerged의 모든 예약문자가 이스케이프되거나 의도적 마크업이다', () => {
    const e = {
      ...newsEvent('한국[은행].주식-회사 (공공기관) 자금.조달!계획'),
      raw: { feedId: 'test', press: '매일[경제]신문-보도' },
    }
    const s = formatNewsMerged([{ event: e, tier: 'high' }])

    // 의도적 마크업: \[ \] (이스케이프된 괄호), DISCLAIMER (이미 _ 포함)
    const intentional = [`\\[`, `\\]`, DISCLAIMER]
    assertNoUnescapedReserved(s, intentional)
  })
})
