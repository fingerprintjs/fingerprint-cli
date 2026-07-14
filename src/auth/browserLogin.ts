import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import open from 'open'
import { resolveConfig } from '../config/config.js'
import { ApiClient, ApiError } from '../api/client.js'
import { saveAuthState } from './tokenStore.js'

// Browser login uses poll delivery (PostHog-style): no local server, no loopback port. The CLI
// generates a high-entropy `hash`, opens the dashboard's /cli-auth page carrying it, and polls the
// mgmt-api for the credential. After the user authorizes a workspace in the browser, mgmt-api mints a
// workspace-scoped Management API key and caches it under the hash; our next poll retrieves it once,
// over TLS. The key never travels in a browser URL or redirect, and there's no port to bind — so this
// works over SSH and inside containers, unlike a loopback flow.
//
// Contract with the dashboard /cli-auth page:
//   open: <dashboardUrl>/cli-auth?hash=<hash>&intent=<login|signup>  (an auth-guarded route: it
//         bounces through the auth page and back, preserving the query, only when there's no active
//         session; `intent` tells the guard whether to send that user to /login or /signup)
//   poll: GET <apiUrl>/sso/cli-auth-poll?hash=<hash> → { status: 'pending' } | { status: 'complete', … }
//
// We open /cli-auth directly rather than /login?redirect_to=… : when a dashboard session already
// exists, /login short-circuits and drops redirect_to, so /cli-auth never loads and the poll never
// completes. Pointing at the destination lets the route guard handle the auth round-trip only when
// it's actually needed — and `intent` lets it pick the right page (a new user shouldn't land on
// /login) without the CLI ever opening /login or /signup directly.

const POLL_PATH = '/sso/cli-auth-poll'
const POLL_INTERVAL_MS = 2000
const TIMEOUT_MS = 5 * 60 * 1000

export interface BrowserLoginResult {
  managementApiKey: string
  workspaceId: string
  region: string
}

interface PollResponse {
  status: 'pending' | 'complete'
  managementApiKey?: string
  workspaceId?: string
  region?: string
}

export async function loginWithBrowser(opts: { intent?: 'login' | 'signup' } = {}): Promise<BrowserLoginResult> {
  const cfg = resolveConfig()
  // High-entropy lookup id. It travels through the browser URL, so security rests on its entropy plus
  // the credential being single-use and short-TTL server-side — never on the URL staying secret.
  const hash = randomBytes(32).toString('base64url')

  const intent = opts.intent ?? 'login'
  const authUrl = `${cfg.dashboardUrl}/cli-auth?hash=${hash}&intent=${intent}`
  console.log(`\nOpening your browser to ${intent === 'signup' ? 'sign up' : 'sign in'}...`)
  console.log(`If it doesn't open, visit:\n  ${authUrl}\n`)
  await open(authUrl).catch(() => {
    // Browser couldn't be opened automatically; the printed URL is the fallback.
  })

  const client = new ApiClient(cfg.apiUrl)
  const deadline = Date.now() + TIMEOUT_MS
  console.log('Waiting for you to finish signing in in the browser...')

  let consecutiveErrors = 0
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error('Login timed out after 5 minutes. Run `fingerprint login` again.')
    }

    let res: PollResponse | null = null
    try {
      res = await client.request<PollResponse>(`${POLL_PATH}?hash=${hash}`, { method: 'GET' })
      consecutiveErrors = 0
    } catch (e) {
      // A 404 means the endpoint isn't there — no point polling for five minutes; surface it now.
      if (e instanceof ApiError && e.status === 404) {
        throw new Error('Login isn’t available right now. Please try again in a few minutes.')
      }
      // No HTTP status means the request never reached the server — almost always no (or blocked)
      // internet. A single failure might be a blip, so retry a few times in case it recovers; give up
      // sooner than for server-side errors since a total lack of connectivity rarely fixes itself.
      const offline = !(e instanceof ApiError)
      if (offline && ++consecutiveErrors >= 3) {
        throw new Error('Couldn’t reach Fingerprint — check your internet connection, then run `fingerprint login` again.')
      }
      // Server-side hiccup (rate limit, brief 5xx): tolerate a longer run before giving up. Keep the
      // message plain — internal URLs and raw fetch errors don't help the person logging in.
      if (!offline && ++consecutiveErrors >= 10) {
        throw new Error('Login failed. Please run `fingerprint login` again.')
      }
    }

    if (res?.status === 'complete' && res.managementApiKey) {
      const result: BrowserLoginResult = {
        managementApiKey: res.managementApiKey,
        workspaceId: res.workspaceId ?? '',
        region: res.region ?? '',
      }
      saveAuthState({
        managementApiKey: result.managementApiKey,
        workspaceId: result.workspaceId,
        region: result.region,
        managementApiUrl: cfg.managementApiUrl,
      })
      return result
    }

    await sleep(POLL_INTERVAL_MS)
  }
}
