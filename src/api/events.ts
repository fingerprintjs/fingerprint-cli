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

// Server-side filters the API applies before paging, so a busy workspace's bad bots are counted
// over the whole window instead of whatever the newest page happened to hold.
export interface SearchFilter {
  bot?: 'bad' | 'good' | 'all' | 'none'
  min_suspect_score?: number
}

export interface SearchOptions {
  serverApiKey: string
  region: string
  start: Date
  end: Date
  max: number
  filter?: SearchFilter
}

// Newest-first identification events in [start, end], paginated up to `max`. Pages are capped at
// 100 by the API. `end` is always sent: the API measures the window from its own clock, and a
// start of "exactly N days ago" would be a hair over N days by the time it arrives.
export async function searchEvents(
  { serverApiKey, region, start, end, max, filter = {} }: SearchOptions,
  fetchImpl: typeof fetch = fetch
): Promise<{ events: TrafficEvent[]; truncated: boolean }> {
  const base = serverApiUrl(region)
  const events: TrafficEvent[] = []
  let paginationKey: string | undefined
  while (events.length < max) {
    const q = new URLSearchParams({ start: start.toISOString(), end: end.toISOString(), limit: String(Math.min(100, max - events.length)) })
    for (const p of PRODUCTS) q.append('products', p)
    if (filter.bot) q.set('bot', filter.bot)
    if (filter.min_suspect_score !== undefined) q.set('min_suspect_score', String(filter.min_suspect_score))
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
  return { events, truncated: Boolean(paginationKey) && events.length >= max }
}

// What `fingerprint analyze` reads. The suspicious events are pulled with API-side filters over
// the whole window, so their counts are real even on a busy workspace. Everything that needs a
// denominator (share of a page's traffic, replays, confidence, SDK versions) comes from a sample
// spread evenly across the window: `max` events in `SLICES` equal time slices, newest first within
// each, instead of the newest `max` overall, which on a busy site covers hours, not days.
export interface TrafficPull {
  sample: TrafficEvent[]
  // True when every slice fit in its share of `max`: the sample is then every event in the window.
  sampleComplete: boolean
  badBots: TrafficEvent[]
  badBotsTruncated: boolean
  highSuspect: TrafficEvent[]
  highSuspectTruncated: boolean
}

export const SLICES = 10
// Suspect Score high enough that most customers review it; it's a sum of weighted signals.
export const HIGH_SUSPECT = 50

export async function pullTraffic(opts: Omit<SearchOptions, 'filter'>, fetchImpl: typeof fetch = fetch): Promise<TrafficPull> {
  const { start, end, max } = opts
  const perSlice = Math.max(1, Math.ceil(max / SLICES))
  const span = (end.getTime() - start.getTime()) / SLICES
  const sample: TrafficEvent[] = []
  let sampleComplete = true
  for (let i = 0; i < SLICES; i++) {
    const sliceStart = new Date(start.getTime() + i * span)
    const sliceEnd = i === SLICES - 1 ? end : new Date(start.getTime() + (i + 1) * span - 1)
    const page = await searchEvents({ ...opts, start: sliceStart, end: sliceEnd, max: perSlice }, fetchImpl)
    sample.push(...page.events)
    if (page.truncated) sampleComplete = false
  }
  const bots = await searchEvents({ ...opts, filter: { bot: 'bad' } }, fetchImpl)
  const suspect = await searchEvents({ ...opts, filter: { min_suspect_score: HIGH_SUSPECT } }, fetchImpl)
  return {
    sample,
    sampleComplete,
    badBots: bots.events,
    badBotsTruncated: bots.truncated,
    highSuspect: suspect.events,
    highSuspectTruncated: suspect.truncated,
  }
}
