import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { fetchCorpEntries } from './corp-code.js'
import { buildCorpIndex, matchCorp } from '../../core/news/corp-index.js'

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<result>
  <list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name>
        <stock_code>005930</stock_code><modify_date>20260101</modify_date></list>
  <list><corp_code>00111111</corp_code><corp_name>비상장회사</corp_name>
        <stock_code> </stock_code><modify_date>20260101</modify_date></list>
  <list><corp_code>00222222</corp_code><corp_name>한미약품</corp_name>
        <stock_code>128940</stock_code><modify_date>20260101</modify_date></list>
</result>`

function zipped(): ArrayBuffer {
  const z = zipSync({ 'CORPCODE.xml': strToU8(XML) })
  return z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength) as ArrayBuffer
}

const okFetch = (async () =>
  new Response(zipped(), { status: 200 })) as unknown as typeof fetch

describe('fetchCorpEntries', () => {
  it('stock_code가 있는 상장사만 돌려준다', async () => {
    const entries = await fetchCorpEntries('k'.repeat(40), okFetch)
    expect(entries).toEqual([
      { name: '삼성전자', ticker: '005930' },
      { name: '한미약품', ticker: '128940' },
    ])
  })

  it('HTTP 오류는 던진다 — 빈 명부로 조용히 도는 것이 최악이다', async () => {
    const bad = (async () => new Response('', { status: 500 })) as unknown as typeof fetch
    await expect(fetchCorpEntries('k'.repeat(40), bad)).rejects.toThrow(/500/)
  })

  it('상장사가 한 곳도 없으면 던진다', async () => {
    const empty = `<result><list><corp_code>1</corp_code><corp_name>A</corp_name>
      <stock_code> </stock_code><modify_date>1</modify_date></list></result>`
    const z = zipSync({ 'CORPCODE.xml': strToU8(empty) })
    const buf = z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength) as ArrayBuffer
    const f = (async () => new Response(buf, { status: 200 })) as unknown as typeof fetch
    await expect(fetchCorpEntries('k'.repeat(40), f)).rejects.toThrow(/상장사/)
  })

  it('별칭을 명부에 더한다', async () => {
    const xml = `<result>
      <list><corp_code>1</corp_code><corp_name>현대자동차</corp_name>
            <stock_code>005380</stock_code><modify_date>1</modify_date></list>
    </result>`
    const z = zipSync({ 'CORPCODE.xml': strToU8(xml) })
    const buf = z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength) as ArrayBuffer
    const f = (async () => new Response(buf, { status: 200 })) as unknown as typeof fetch
    const entries = await fetchCorpEntries('k'.repeat(40), f)
    expect(entries).toContainEqual({ name: '현대자동차', ticker: '005380' })
    expect(entries).toContainEqual({ name: '현대차', ticker: '005380' })
  })

  it('명부에 없는 티커의 별칭은 넣지 않는다 — 상장폐지 종목이 영원히 잘못 잡힌다', async () => {
    const xml = `<result>
      <list><corp_code>1</corp_code><corp_name>삼성전자</corp_name>
            <stock_code>005930</stock_code><modify_date>1</modify_date></list>
    </result>`
    const z = zipSync({ 'CORPCODE.xml': strToU8(xml) })
    const buf = z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength) as ArrayBuffer
    const f = (async () => new Response(buf, { status: 200 })) as unknown as typeof fetch
    const entries = await fetchCorpEntries('k'.repeat(40), f)
    expect(entries.map((e) => e.name)).not.toContain('현대차')
  })

  it('법인명의 XML 엔티티를 디코딩한다 — 삼성E&A 처럼 &amp;로 등록된 회사가 실제 20개사 있다', async () => {
    const xml = `<result>
      <list><corp_code>1</corp_code><corp_name>삼성E&amp;A</corp_name>
            <stock_code>028050</stock_code><modify_date>1</modify_date></list>
    </result>`
    const z = zipSync({ 'CORPCODE.xml': strToU8(xml) })
    const buf = z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength) as ArrayBuffer
    const f = (async () => new Response(buf, { status: 200 })) as unknown as typeof fetch
    const entries = await fetchCorpEntries('k'.repeat(40), f)
    expect(entries).toEqual([{ name: '삼성E&A', ticker: '028050' }])

    // 디코딩 안 하면 등록명 "삼성E&amp;A" 가 뉴스 표기 "삼성E&A" 와 영원히 안 맞는다.
    const index = buildCorpIndex(entries)
    expect(matchCorp('삼성E&A 대형 수주 발표', index)?.ticker).toBe('028050')
  })

  it('KT&G 별칭이 명부에 더해지고, 실제 매칭에서 KT 로 오귀속되지 않는다', async () => {
    const xml = `<result>
      <list><corp_code>1</corp_code><corp_name>주식회사 케이티앤지</corp_name>
            <stock_code>033780</stock_code><modify_date>1</modify_date></list>
    </result>`
    const z = zipSync({ 'CORPCODE.xml': strToU8(xml) })
    const buf = z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength) as ArrayBuffer
    const f = (async () => new Response(buf, { status: 200 })) as unknown as typeof fetch
    const entries = await fetchCorpEntries('k'.repeat(40), f)
    expect(entries).toContainEqual({ name: 'KT&G', ticker: '033780' })

    const index = buildCorpIndex(entries)
    expect(matchCorp('KT&G, 3분기 영업이익 15% 증가', index)?.ticker).toBe('033780')
  })
})
