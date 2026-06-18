import { getAuthState } from '../auth/tokenStore.js'
import { DEFAULT_GATEWAY_URL } from '../config/config.js'

export interface LlmConfig {
  model: string
  env: Record<string, string | undefined>
}

// Auth seam. Today: route the agent SDK at the Fingerprint LLM gateway (DEFAULT_GATEWAY_URL,
// env-overridable in config.ts), authenticated with the Fingerprint login token. Swapping the
// gateway URL (or pointing straight at Anthropic) is a config change there, not a rewrite.
export function resolveLlmConfig(): LlmConfig {
  const auth = getAuthState()
  if (!auth?.accessToken) throw new Error('Not logged in. Run: fingerprint login')

  const env: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_BASE_URL: DEFAULT_GATEWAY_URL,
    ANTHROPIC_AUTH_TOKEN: auth.accessToken, // sent as `Authorization: Bearer <token>`
    ANTHROPIC_API_KEY: undefined, // don't let a stray key override the gateway routing
  }

  return {
    model: process.env.FINGERPRINT_WIZARD_MODEL ?? 'claude-sonnet-4-6',
    env,
  }
}
