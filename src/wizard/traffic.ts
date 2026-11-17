import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { HIGH_SUSPECT, type TrafficEvent, type TrafficPull } from '../api/events.js'

// What `fingerprint analyze` concludes from a workspace's recent identification events, per page.
// Pure: events in, numbers out, so the thresholds below are testable without a network.
//
// Two kinds of number per page. `badBots` and `highSuspect` are counts over the whole window,
// pulled with API-side filters. `sampled`, `vpn`, `replayed`, `lowConfidence` and `visitors` come
// from the evenly spread sample, so they describe the page's traffic mix, not its total.
export interface PageStats {
  path: string
  badBots: number
  highSuspect: number
  sampled: number
  sampledBadBots: number
  vpn: number
  replayed: number
  lowConfidence: number
  visitors: number
}

export interface TrafficSummary {
  sampled: number
  sampleComplete: boolean
  badBots: number
  badBotsTruncated: boolean
  highSuspect: number
  highSuspectTruncated: boolean
  pages: PageStats[]
  sdkVersions: Record<string, number>
  oldestMs?: number
  newestMs?: number
}

// Below this a visitor id is unreliable enough to be worth a look (see docs: confidence score).
const LOW_CONFIDENCE = 0.5

function emptyPage(path: string): PageStats {
  return { path, badBots: 0, highSuspect: 0, sampled: 0, sampledBadBots: 0, vpn: 0, replayed: 0, lowConfidence: 0, visitors: 0 }
}

export function summarizeTraffic(pull: Pick<TrafficPull, 'sample' | 'badBots' | 'highSuspect'> & Partial<TrafficPull>): TrafficSummary {
  const byPath = new Map<string, PageStats>()
  const visitorsByPath = new Map<string, Set<string>>()
  const page = (ev: TrafficEvent) => {
    const path = pathOf(ev.url)
    let p = byPath.get(path)
    if (!p) {
      p = emptyPage(path)
      byPath.set(path, p)
    }
    return p
  }

  for (const ev of pull.badBots) page(ev).badBots++
  for (const ev of pull.highSuspect) page(ev).highSuspect++

  const sdkVersions: Record<string, number> = {}
  let oldestMs: number | undefined
  let newestMs: number | undefined
  for (const ev of pull.sample) {
    const p = page(ev)
    p.sampled++
    if (ev.bot === 'bad') p.sampledBadBots++
    if (ev.vpn) p.vpn++
    if (ev.replayed) p.replayed++
    const score = ev.identification?.confidence?.score
    if (typeof score === 'number' && score < LOW_CONFIDENCE) p.lowConfidence++
    if (ev.identification?.visitor_id) {
      let ids = visitorsByPath.get(p.path)
      if (!ids) visitorsByPath.set(p.path, (ids = new Set()))
      ids.add(ev.identification.visitor_id)
    }
    if (ev.sdk?.version) {
      const key = `${ev.sdk.platform ?? 'js'} ${ev.sdk.version}`
      sdkVersions[key] = (sdkVersions[key] ?? 0) + 1
    }
    if (typeof ev.timestamp === 'number') {
      oldestMs = oldestMs === undefined ? ev.timestamp : Math.min(oldestMs, ev.timestamp)
      newestMs = newestMs === undefined ? ev.timestamp : Math.max(newestMs, ev.timestamp)
    }
  }
  for (const [path, ids] of visitorsByPath) byPath.get(path)!.visitors = ids.size

  // Suspicious first: a page with bad bots outranks a busy clean one.
  const pages = [...byPath.values()].sort((a, b) => signals(b) - signals(a) || b.sampled - a.sampled)
  return {
    sampled: pull.sample.length,
    sampleComplete: pull.sampleComplete ?? true,
    badBots: pull.badBots.length,
    badBotsTruncated: pull.badBotsTruncated ?? false,
    highSuspect: pull.highSuspect.length,
    highSuspectTruncated: pull.highSuspectTruncated ?? false,
    pages,
    sdkVersions,
    oldestMs,
    newestMs,
  }
}

export const signals = (p: PageStats) => p.badBots + p.highSuspect + p.replayed

function pathOf(url?: string): string {
  if (!url) return '(no url)'
  try {
    return new URL(url).pathname || '/'
  } catch {
    return url
  }
}

export interface Suggestion {
  title: string
  detail: string
  docs: string
  // What the integrate agent is told to do when the user picks this one. Unset when the fix is
  // not a code change (a custom subdomain has its own step; pinning a version is the user's call).
  step?: string
  activity?: string
}

export interface SuggestOptions {
  // `fingerprint analyze` passes the server-verification step through; the wording lives with the
  // other menu steps in runner.ts and is injected here to keep this module free of the agent.
  steps?: { serverVerification: string }
  days?: number
}

// Each suggestion names the page, the count behind the finding, and the one thing to do about it.
// Bad bots and high Suspect Scores are whole-window counts, so the bar is a plain count; shares
// are quoted from the sample as context. Thresholds are conservative: a report that cries wolf
// gets ignored.
export function suggest(summary: TrafficSummary, repo: { verifiesServerSide: boolean }, { steps, days }: SuggestOptions = {}): Suggestion[] {
  const out: Suggestion[] = []
  if (summary.sampled === 0 && summary.badBots === 0 && summary.highSuspect === 0) return out
  const window = days === undefined ? 'the report window' : `the last ${days} day${days === 1 ? '' : 's'}`

  if (!repo.verifiesServerSide) {
    const n = summary.pages.length
    out.push({
      title: 'Verify identification server-side',
      detail: `${n} page${n === 1 ? '' : 's'} identify but this repo never reads the event from the Server API, so a client can send any result. Run \`fingerprint integrate\` to add the check.`,
      docs: 'https://docs.fingerprint.com/docs/get-server-side-intelligence',
      step: steps?.serverVerification,
      activity: 'Setting up server-side verification',
    })
  }

  for (const page of summary.pages) {
    const pct = (n: number) => Math.round((100 * n) / page.sampled)
    // "~44% of its traffic": the page's bad-bot share in the sample, when the sample has enough
    // of the page to mean anything. Exact when the sample is every event in the window.
    const share = (n: number) =>
      summary.sampleComplete ? ` (${pct(n)}% of its ${page.sampled} events)` : page.sampled >= 10 ? ` (~${pct(n)}% of its traffic, sampled)` : ''

    if (page.badBots >= 5) {
      out.push({
        title: `Block bad bots on ${page.path}`,
        detail: `${page.badBots} bad-bot events in ${window}${share(page.sampledBadBots)}. Rules Engine: "Bot detection is Bad → Block 403" would have stopped them without code changes.`,
        docs: 'https://docs.fingerprint.com/docs/rules-engine',
        step: `block bad bots on the action behind the page ${page.path}: ${page.badBots} identification events there in ${window} were bad bots${share(page.sampledBadBots)}. In the server-side verification for that action, read the event from the Server API and reject the request when its \`bot\` is "bad" (follow the fingerprint-smart-signals skill's bot detection guidance; do not act on client-reported values). Then tell the user the no-code alternative from the fingerprint-rules-engine skill: a ruleset "Bot detection is Bad → Block", evaluated by passing its ruleset_id to the Server API`,
        activity: `Blocking bad bots on ${page.path}`,
      })
    }
    if (page.replayed >= 3) {
      out.push({
        title: `Reject replayed events on ${page.path}`,
        detail: `${page.replayed} of ${page.sampled} sampled events were replayed: the same event id sent more than once. Check the event's timestamp server-side and accept each id once.`,
        docs: 'https://docs.fingerprint.com/docs/protecting-from-client-side-tampering',
        step: `reject replayed events on the action behind the page ${page.path}: ${page.replayed} of ${page.sampled} sampled event ids there were sent more than once. In the server-side verification for that action, reject an event whose timestamp is older than a short freshness window, and remember each accepted event_id so it is accepted once (follow the fingerprint-smart-signals skill; keep the store simple and match the app's existing patterns)`,
        activity: `Rejecting replayed events on ${page.path}`,
      })
    }
    if (page.highSuspect >= 5) {
      out.push({
        title: `Review high Suspect Scores on ${page.path}`,
        detail: `${page.highSuspect} events in ${window} scored ${HIGH_SUSPECT}+. Rules Engine: allow with a header your backend reads, and route those to extra verification.`,
        docs: 'https://docs.fingerprint.com/docs/suspect-score',
        step: `route suspicious traffic on the action behind the page ${page.path} to extra verification: ${page.highSuspect} events there in ${window} had suspect_score of ${HIGH_SUSPECT} or more. In the server-side verification for that action, read suspect_score from the event and send those requests down the app's existing step-up or review path instead of blocking them (follow the fingerprint-smart-signals skill). Do not invent a step-up flow if the app has none; say what is missing`,
        activity: `Routing high Suspect Scores on ${page.path} to review`,
      })
    }
    if (page.lowConfidence >= 5 && pct(page.lowConfidence) >= 10) {
      out.push({
        title: `Low identification confidence on ${page.path}`,
        detail: `${page.lowConfidence} of ${page.sampled} sampled events (${pct(page.lowConfidence)}%) had confidence below ${LOW_CONFIDENCE}. Serve the agent from a custom subdomain so browsers stop treating it as third-party.`,
        docs: 'https://docs.fingerprint.com/docs/custom-subdomain-setup',
      })
    }
  }

  const versions = Object.keys(summary.sdkVersions)
  if (versions.length > 1) {
    out.push({
      title: 'More than one agent version in traffic',
      detail: `Seen: ${versions.join(', ')}. Pin one version so every page gets the same signals.`,
      docs: 'https://docs.fingerprint.com/docs/changelog',
    })
  }
  return out
}

// Does this repo read events back from the Server API? A grep for the SDKs and the raw endpoint,
// skipping dependency and build output. Good enough to tell "identifies only" from "verifies".
const VERIFY_MARKERS = ['@fingerprint/server-sdk', '@fingerprintjs/fingerprintjs-pro-server-api', 'fingerprint_pro_server_api_sdk', 'fingerprint-pro-server-api', 'api.fpjs.io', '/v4/events', '/v3/events']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', 'vendor', '.venv', 'venv'])
const SOURCE_EXT = /\.(m?[jt]sx?|py|go|rb|php|java|kt|cs|rs|toml|txt|json)$/

export function verifiesServerSide(root: string): boolean {
  const stack = [root]
  let budget = 5000
  while (stack.length && budget-- > 0) {
    const dir = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) stack.push(full)
      else if (SOURCE_EXT.test(name) && st.size < 512 * 1024) {
        const text = readFileSync(full, 'utf8')
        if (VERIFY_MARKERS.some((m) => text.includes(m))) return true
      }
    }
  }
  return false
}
