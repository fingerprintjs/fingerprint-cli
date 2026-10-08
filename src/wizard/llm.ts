import { getFreshAccessToken } from '../auth/refresh.js'
import { resolveConfig } from '../config/config.js'

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

  // The gateway rejects any other model; naming it here lets the SDK shape requests for the model that runs.
  return { model: 'claude-sonnet-5-5', env }
}
