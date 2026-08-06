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

  const env: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_BASE_URL: resolveConfig().gatewayUrl,
    ANTHROPIC_AUTH_TOKEN: accessToken, // sent as `Authorization: Bearer <jwt>`
    ANTHROPIC_API_KEY: undefined, // don't let a stray key override the gateway routing
  }

  return {
    model: process.env.FINGERPRINT_WIZARD_MODEL ?? 'claude-sonnet-4-6',
    env,
  }
}
