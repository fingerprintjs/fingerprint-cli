export type Region = 'us' | 'eu' | 'ap'
export type Environment = 'production' | 'staging'

interface EnvironmentUrls {
  // Private mgmt-api. The CLI hits only one endpoint here: GET /sso/cli-auth-poll during browser
  // login, to poll for the minted Management key. No dashboard session is ever held.
  apiUrl: string
  // Public Management API the CLI drives with its workspace-scoped Management API key (create/list
  // API keys + environments). This is where all post-login work happens.
  managementApiUrl: string
  // Dashboard hosting the browser-login + /cli-auth page. The Management key it mints is only valid
  // against the SAME environment, so these URLs must always come from one preset — never mix them.
  dashboardUrl: string
  // Hosted Fingerprint LLM gateway (Cloudflare Worker) the agent SDK is pointed at, so end users
  // never need an Anthropic key. It authenticates callers by the Management API key.
  gatewayUrl: string
}

// Each environment bundles the URLs that must move together. Defaults to production; set
// FINGERPRINT_ENV=staging for internal use. Individual FINGERPRINT_*_URL vars still override a
// single value.
const ENVIRONMENTS: Record<Environment, EnvironmentUrls> = {
  production: {
    apiUrl: 'https://api.fpjs.pro',
    managementApiUrl: 'https://management-api.fpjs.io',
    dashboardUrl: 'https://dashboard.fingerprint.com',
    gatewayUrl: 'https://fingerprint-llm-gateway.elvo.workers.dev',
  },
  staging: {
    apiUrl: 'http://localhost:3001',
    managementApiUrl: 'https://public-api-preview-acc05757.fpjs.sh',
    dashboardUrl: 'http://localhost:3000',
    gatewayUrl: 'https://fingerprint-llm-gateway.elvo.workers.dev',
  },
}

const DEFAULT_ENVIRONMENT: Environment = 'production'

function selectEnvironment(): Environment {
  const name = (process.env.FINGERPRINT_ENV ?? DEFAULT_ENVIRONMENT) as Environment
  if (!(name in ENVIRONMENTS)) {
    throw new Error(`Unknown environment "${name}". Use one of: ${Object.keys(ENVIRONMENTS).join(', ')}`)
  }
  return name
}

export interface RuntimeConfig {
  apiUrl: string
  managementApiUrl: string
  dashboardUrl: string
  gatewayUrl: string
  region: Region
}

// Precedence per URL: explicit arg / per-URL env var > selected environment preset.
export function resolveConfig(apiUrl?: string, region?: string): RuntimeConfig {
  const env = ENVIRONMENTS[selectEnvironment()]
  const resolvedRegion = (region ?? process.env.FINGERPRINT_REGION ?? 'us') as Region
  return {
    apiUrl: apiUrl ?? process.env.FINGERPRINT_API_URL ?? env.apiUrl,
    managementApiUrl: process.env.FINGERPRINT_MANAGEMENT_API_URL ?? env.managementApiUrl,
    dashboardUrl: process.env.FINGERPRINT_DASHBOARD_URL ?? env.dashboardUrl,
    gatewayUrl: process.env.FINGERPRINT_GATEWAY_URL ?? env.gatewayUrl,
    region: resolvedRegion,
  }
}

// Server region codes accepted by POST /subscriptions/start (mirrors the dashboard's REGIONS).
export type RegionCode = 'use1' | 'euc1' | 'aps1'

export const REGION_CHOICES: { name: string; value: RegionCode }[] = [
  { name: 'North America — Virginia (use1) — Most popular', value: 'use1' },
  { name: 'Europe — Frankfurt (euc1)', value: 'euc1' },
  { name: 'Asia Pacific — Mumbai (aps1)', value: 'aps1' },
]
