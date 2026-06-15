import { getAuthState } from '../auth/tokenStore.js'

export interface LlmConfig {
  model: string
  env: Record<string, string | undefined>
}

// Hosted Fingerprint LLM gateway (Cloudflare Worker). The agent SDK is pointed here so end
// users never need an Anthropic key. Override with FINGERPRINT_GATEWAY_URL for local dev.
const DEFAULT_GATEWAY_URL = 'https://fingerprint-llm-gateway.sedanur-yildiz.workers.dev'

// Auth seam. Today: route the agent SDK at the Fingerprint LLM gateway, authenticated with
// the Fingerprint login token. Swapping the gateway URL (or pointing straight at Anthropic)
// is a config change here, not a rewrite.
export function resolveLlmConfig(): LlmConfig {
  const auth = getAuthState()
  if (!auth?.accessToken) throw new Error('Not logged in. Run: fingerprint login')

  const gatewayUrl = process.env.FINGERPRINT_GATEWAY_URL ?? DEFAULT_GATEWAY_URL

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
