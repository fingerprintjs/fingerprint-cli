export type Region = 'us' | 'eu' | 'ap'
export type Environment = 'production' | 'staging'

interface EnvironmentUrls {
  // mgmt-api the CLI talks to.
  apiUrl: string
  // Dashboard hosting the browser-login page. Tokens it mints are only valid against the SAME
  // environment's mgmt-api, so these two must always come from the same preset — never mix them.
  dashboardUrl: string
  // Hosted Fingerprint LLM gateway (Cloudflare Worker) the agent SDK is pointed at, so end users
  // never need an Anthropic key.
  gatewayUrl: string
}

// Each environment bundles the three URLs that must move together. Defaults to production; set
// FINGERPRINT_ENV=staging for internal use. Individual FINGERPRINT_*_URL vars still override a
// single URL.
const ENVIRONMENTS: Record<Environment, EnvironmentUrls> = {
  production: {
    apiUrl: 'https://mgmtapi.fpjs.io',
    dashboardUrl: 'https://dashboard.fingerprint.com',
    gatewayUrl: 'https://llm-gateway.fpjs.sh',
  },
  staging: {
    apiUrl: 'https://mgmtapi.fpjs.sh',
    dashboardUrl: 'https://dashboard.fpjs.sh',
    gatewayUrl: 'https://llm-gateway.fpjs.sh',
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
