import { getAuthState } from '../auth/tokenStore.js'

export interface LlmConfig {
  model: string
  env: Record<string, string | undefined>
}

// Auth seam. Today: route the agent SDK at the Fingerprint LLM gateway, authenticated with
// the Fingerprint login token. Swapping the gateway URL (or pointing straight at Anthropic)
// is a config change here, not a rewrite.
export function resolveLlmConfig(): LlmConfig {
  const auth = getAuthState()
  if (!auth?.accessToken) throw new Error('Not logged in. Run: fingerprint login')

  const gatewayUrl = process.env.FINGERPRINT_GATEWAY_URL ?? 'http://127.0.0.1:8787'

  const env: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_BASE_URL: gatewayUrl,
    ANTHROPIC_AUTH_TOKEN: auth.accessToken, // sent as `Authorization: Bearer <token>`
    ANTHROPIC_API_KEY: undefined, // don't let a stray key override the gateway routing
  }

  return {
    model: process.env.FINGERPRINT_WIZARD_MODEL ?? 'claude-sonnet-4-6',
    env,
  }
}
