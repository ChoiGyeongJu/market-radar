import { unzipSync, strFromU8 } from 'fflate'
import { CORP_ALIASES, type CorpEntry } from '../../core/news/corp-index.js'

const ENDPOINT = 'https://opendart.fss.or.kr/api/corpCode.xml'

/** 명부는 하루 한 번 받으면 되므로 목록 API보다 넉넉히 준다 — 응답이 수 MB다. */
const REQUEST_TIMEOUT_MS = 30_000

const LIST_RE = /<list>([\s\S]*?)<\/list>/g

function field(block: string, name: string): string {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)
  return (m?.[1] ?? '').trim()
}

/**
 * DART 전체 기업 고유번호에서 상장사만 추린다. `stock_code` 가 공백이면 비상장이다.
 *
 * 실패 시 반드시 던진다. 빈 명부로 조용히 도는 것이 최악의 실패다 — 모든 뉴스가
 * `no-corp-match` 로 drop 되면서 워커는 정상으로 보이고 알림만 0건이 된다.
 * 이 프로젝트에서 반복된 실패 유형(재보지 않은 부재를 보고하기)과 같은 것이다.
 */
export async function fetchCorpEntries(
  apiKey: string, fetchImpl?: typeof fetch,
): Promise<CorpEntry[]> {
  const doFetch = fetchImpl ?? fetch
  const url = new URL(ENDPOINT)
  url.searchParams.set('crtfc_key', apiKey)

  const res = await doFetch(url.toString(), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`corpCode HTTP ${res.status}`)

  const files = unzipSync(new Uint8Array(await res.arrayBuffer()))
  const name = Object.keys(files).find((f) => f.toUpperCase().endsWith('.XML'))
  if (!name) throw new Error('corpCode ZIP 안에 XML이 없다')

  const xml = strFromU8(files[name]!)
  const out: CorpEntry[] = []
  for (const m of xml.matchAll(LIST_RE)) {
    const ticker = field(m[1]!, 'stock_code')
    const corpName = field(m[1]!, 'corp_name')
    if (ticker && corpName) out.push({ name: corpName, ticker })
  }

  if (out.length === 0) throw new Error('corpCode 응답에 상장사가 한 곳도 없다')

  // 별칭을 붙인다. 티커가 명부에 실제로 있는 것만 — 상장폐지된 티커의 별칭을
  // 남겨두면 그 이름이 영원히 잘못된 회사로 잡힌다.
  const tickers = new Set(out.map((e) => e.ticker))
  for (const a of CORP_ALIASES) {
    if (tickers.has(a.ticker)) out.push({ name: a.alias, ticker: a.ticker })
  }

  return out
}
