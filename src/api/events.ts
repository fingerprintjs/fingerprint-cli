import { serverApiUrl } from '../config/config.js'
import { CodedError } from '../errors.js'
import { debugLog } from '../utils/log-file.js'
import { VERSION } from '../version.js'

// The slice of a v4 identification event that `fingerprint analyze` aggregates. Everything else the
// Server API returns is dropped at the boundary so a page of 100 events stays small.
export interface TrafficEvent {
  event_id: string
  timestamp: number
  url?: string
  bot?: 'bad' | 'good' | 'not_detected'
  vpn?: boolean
  suspect_score?: number
  replayed?: boolean
  tampering?: boolean
  identification?: { visitor_id?: string; confidence?: { score?: number } }
  sdk?: { platform?: string; version?: string }
}

interface SearchResponse {
  events: TrafficEvent[]
  pagination_key?: string
}

// Only the fields the summary reads, so the response is a fraction of the full event.
const PRODUCTS = ['identification', 'bot', 'vpn', 'suspect_score', 'tampering'] as const

// Newest-first identification events since `start`, paginated up to `max`. Pages are capped at
// 100 by the API; `max` keeps a busy workspace from turning a quick report into a long download.
export async function searchEvents(
  { serverApiKey, region, start, max }: { serverApiKey: string; region: string; start: Date; max: number },
  fetchImpl: typeof fetch = fetch
): Promise<TrafficEvent[]> {
  const base = serverApiUrl(region)
  const events: TrafficEvent[] = []
  let paginationKey: string | undefined
  while (events.length < max) {
    const q = new URLSearchParams({ start: start.toISOString(), limit: String(Math.min(100, max - events.length)) })
    for (const p of PRODUCTS) q.append('products', p)
    if (paginationKey) q.set('pagination_key', paginationKey)
    const url = `${base}/events?${q}`
    let res: Response
    try {
      res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${serverApiKey}`, 'User-Agent': `fingerprint-cli/${VERSION}` },
      })
    } catch (e) {
      debugLog(`Server API request to ${url} failed: ${e instanceof Error ? e.message : String(e)}`)
      throw new CodedError('server_api_unreachable', `Couldn’t reach the Server API at ${new URL(base).origin}. Check your connection.`)
    }
    const body = (await res.json().catch(() => ({}))) as SearchResponse | { error?: { code?: string; message?: string } }
    if (!res.ok) {
      const err = 'error' in body ? body.error : undefined
      throw new CodedError(`server_api_${err?.code ?? res.status}`, err?.message ?? `Server API request failed (${res.status})`)
    }
    const page = body as SearchResponse
    events.push(...(page.events ?? []))
    paginationKey = page.pagination_key
    if (!paginationKey || !page.events?.length) break
  }
  return events
}
