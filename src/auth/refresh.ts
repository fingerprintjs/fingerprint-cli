import { resolveConfig } from '../config/config.js'
import { debugLog } from '../utils/log-file.js'
import { decodeJwtPayload, discoverEndpoints, type TokenResponse } from './browserLogin.js'
import { getAuthState, updateAuthState } from './tokenStore.js'

// The access token from login is short-lived, so "am I logged in?" can't just mean "is there a file on
// disk?". This module is the single place that hands out a token known to still be good: it checks the
// `exp` claim and, when the token is spent, trades the refresh token for a new one. Callers get either
// a live token or a clear instruction to log in again — never a stale token that 401s deep in a run.
//
// The LLM gateway verifies `exp` too and answers 401 `token_expired`; refreshing here means the CLI
// renews before the request rather than after it fails.

// Renew slightly early so a token that passes the check is still valid when the request lands.
const EXPIRY_SKEW_MS = 60_000

const LOGIN_HINT = 'Run: fingerprint login'
const LOGGED_OUT = `Not logged in. ${LOGIN_HINT}`
const SESSION_EXPIRED = `Your session expired. ${LOGIN_HINT}`
// A dead connection is not a dead session: renewing needs the network, and so would logging in again,
// so this case says what actually went wrong instead of sending the user at a browser round-trip.
const UNREACHABLE = 'Couldn’t reach the login service to renew your session. Check your connection and try again.'

// The messages above carry their own `Run: …` hint, for callers that surface a bare message (the
// top-level handler in index.ts). Callers that render their own recovery list strip it so the same
// instruction isn't printed twice.
export function withoutLoginHint(message: string): string {
  return message.replace(` ${LOGIN_HINT}`, '')
}

// Read expiry off the token itself rather than storing it separately — one source of truth, and it
// also covers auth state written before refresh support existed. A token we can't read an `exp` from
// is left alone: the gateway is the authority, so let it decide rather than forcing a needless login.
function isSpent(token: string): boolean {
  try {
    const exp = decodeJwtPayload(token).exp
    if (typeof exp !== 'number') return false
    return exp * 1000 - Date.now() <= EXPIRY_SKEW_MS
  } catch {
    return false
  }
}

// Can the saved credentials still produce a live token without the user logging in again — either a
// token that hasn't expired, or a spent one we hold a refresh token for? Mirrors the two throw
// conditions below, without the network call. Lets the welcome message avoid announcing "signed in"
// for credentials that will fail the moment anything uses them.
export function hasUsableSession(): boolean {
  const auth = getAuthState()
  if (!auth?.accessToken) return false
  return !isSpent(auth.accessToken) || Boolean(auth.refreshToken)
}

// Returns an access token that is valid now, refreshing it first if needed.
export async function getFreshAccessToken(): Promise<string> {
  const auth = getAuthState()
  if (!auth?.accessToken) throw new Error(LOGGED_OUT)
  if (!isSpent(auth.accessToken)) return auth.accessToken
  if (!auth.refreshToken) throw new Error(SESSION_EXPIRED)

  const cfg = resolveConfig()
  const { token_endpoint } = await discoverEndpoints(cfg.oauthIssuer)
  const res = await fetch(token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken,
      client_id: cfg.oauthClientId,
    }),
  }).catch((err: Error) => {
    // Network-level failure: rejects rather than returning a response, so it never reaches the
    // !res.ok branch below and would otherwise surface as a bare "fetch failed".
    debugLog(`token refresh fetch failed: ${err.message}${err.cause ? ` (${String(err.cause)})` : ''}`)
    throw new Error(UNREACHABLE)
  })

  // A refresh token that's expired or revoked comes back 400 — nothing to retry, the user has to log
  // in again. Same outcome for any other failure here, so keep one message.
  if (!res.ok) {
    debugLog(`token refresh failed: HTTP ${res.status}`)
    throw new Error(SESSION_EXPIRED)
  }

  const token = (await res.json()) as TokenResponse
  if (!token.access_token) {
    debugLog('token refresh returned no access_token')
    throw new Error(SESSION_EXPIRED)
  }

  // Refresh tokens rotate: the response carries the one to use next time, and the old one is now dead.
  // Persist it or the *next* refresh fails. Keep the previous one only if the server didn't send a new one.
  updateAuthState({
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? auth.refreshToken,
  })
  return token.access_token
}
