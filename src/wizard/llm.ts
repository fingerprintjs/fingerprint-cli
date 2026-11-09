import { getFreshAccessToken, LOGIN_HINT } from '../auth/refresh.js'
import { resolveConfig } from '../config/config.js'
import { CodedError } from '../errors.js'
import { debugLog } from '../utils/log-file.js'

// The only model the gateway accepts.
const MODEL = 'claude-sonnet-5-5'

export interface LlmConfig {
  model: string
  env: Record<string, string | undefined>
}

// Auth seam. Route the agent SDK at the Fingerprint LLM gateway (resolved per environment in
// config.ts, env-overridable), authenticated with the OAuth access token (JWT) from browser login —
// the gateway verifies it against the MCP auth server's JWKS. Swapping the gateway URL (or pointing
// straight at Anthropic) is a config change there, not a rewrite.
//
// The token is resolved through getFreshAccessToken() rather than read from disk: the SDK gets the
// token as an env var and holds it for the whole run, so it has to be live at hand-off time.
export async function resolveLlmConfig(): Promise<LlmConfig> {
  const accessToken = await getFreshAccessToken()

  // Drop the user's own model settings (ANTHROPIC_DEFAULT_HAIKU_MODEL, ANTHROPIC_SMALL_FAST_MODEL, …):
  // the SDK would use them for side calls, which the gateway rejects.
  const inherited = Object.entries(process.env).filter(([key]) => !/^(ANTHROPIC|CLAUDE_CODE)_.*MODEL/.test(key))

  const env: Record<string, string | undefined> = {
    ...Object.fromEntries(inherited),
    ANTHROPIC_BASE_URL: resolveConfig().gatewayUrl,
    ANTHROPIC_AUTH_TOKEN: accessToken, // sent as `Authorization: Bearer <jwt>`
    ANTHROPIC_API_KEY: undefined, // don't let a stray key override the gateway routing
  }

  return { model: MODEL, env }
}

// An unexpired token can still be one the gateway rejects (other environment, revoked). count_tokens
// with no messages is refused upstream before any model is spent, so it only proves the token works.
export async function verifyGatewayAccess(accessToken: string): Promise<void> {
  const res = await fetch(`${resolveConfig().gatewayUrl}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ model: MODEL, messages: [] }),
  }).catch((err: Error) => {
    debugLog(`gateway session check failed: ${err.message}${err.cause ? ` (${String(err.cause)})` : ''}`)
    throw new CodedError('gateway_unreachable', 'Couldn’t reach the Fingerprint LLM gateway to check your session. Check your connection and try again.')
  })
  if (res.status !== 401 && res.status !== 403) return
  const { error } = (await res.json().catch(() => ({}))) as { error?: string }
  debugLog(`gateway rejected the access token: HTTP ${res.status} ${error ?? ''}`)
  // Other 403s are about the request, not the token.
  if (res.status === 403 && error !== 'invalid_token' && error !== 'insufficient_scope') return
  throw new CodedError('session_invalid', `Your session is no longer valid. ${LOGIN_HINT}`)
}
