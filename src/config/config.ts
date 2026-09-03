export type Region = 'us' | 'eu' | 'ap'
export type Environment = 'production' | 'staging'

interface EnvironmentUrls {
  // Public Management API the CLI drives with its workspace-scoped Management API key (create/list
  // API keys + environments). This is where all post-login work happens.
  managementApiUrl: string
  // Hosted Fingerprint LLM gateway (Node/Fastify on EKS) the agent SDK is pointed at, so end users
  // never need an Anthropic key. It authenticates callers by the OAuth access token (JWT), verified
  // against the auth server's JWKS. Overridable via FINGERPRINT_GATEWAY_URL.
  gatewayUrl: string
  // WorkOS AuthKit OAuth issuer — the AuthKit domain of the WorkOS environment the CLI app lives in
  // (like MCP's `https://mcpauth.fpjs.io`), NOT `api.workos.com` (that's WorkOS's management API,
  // only called server-side by mgmt-api). Endpoints are discovered from
  // `<issuer>/.well-known/oauth-authorization-server`.
  oauthIssuer: string
  // Public OAuth client id registered in WorkOS for the CLI (PKCE, loopback redirect). Per-environment
  // because WorkOS clients are per-environment. Overridable via FINGERPRINT_OAUTH_CLIENT_ID.
  oauthClientId: string
  // The dashboard the user signs in to; the CLI links to its Get Started page at the end of a run.
  dashboardUrl: string
}

// Each environment bundles the URLs that must move together. Defaults to production; set
// FINGERPRINT_ENV=staging for internal use. Individual FINGERPRINT_*_URL vars still override a
// single value.
const ENVIRONMENTS: Record<Environment, EnvironmentUrls> = {
  production: {
    managementApiUrl: 'https://management-api.fpjs.io',
    gatewayUrl: 'https://llm-gateway.fpjs.io',
    oauthIssuer: 'https://mcpauth.fingerprint.com',
    oauthClientId: 'client_01KYHSG8DC4YHTJGWRADHBZ24D',
    dashboardUrl: 'https://dashboard.fingerprint.com',
  },
  staging: {
    managementApiUrl: 'https://public-mgmtapi.fpjs.sh',
    gatewayUrl: 'https://llm-gateway.fpjs.sh',
    oauthIssuer: 'https://scientific-cat-58-staging.authkit.app',
    oauthClientId: 'client_01KYHMB30PPDR66CWY8BKVTZRX',
    dashboardUrl: 'https://dashboard.fpjs.sh',
  },
}

// OAuth scopes the CLI requests. No custom permissions/scopes are defined in the WorkOS environment,
// and requesting an undefined scope 400s the authorize call — so these are the two standard ones only.
// `offline_access` is what makes the auth server return a refresh token: access tokens are short-lived,
// and without it a session dies minutes after login with no way back but another browser round-trip
// (see auth/refresh.ts). The Management key travels in the token subject (not via scopes), and the LLM
// gateway accepts any valid token from the issuer (its scope check is unset).
// `email` is a standard OIDC scope both issuers advertise in `scopes_supported`; it puts the user's
// email in the id_token, which is the only source for it (neither issuer publishes userinfo).
export const OAUTH_SCOPES = ['openid', 'offline_access', 'email']

const DEFAULT_ENVIRONMENT: Environment = 'production'

function selectEnvironment(): Environment {
  const name = (process.env.FINGERPRINT_ENV ?? DEFAULT_ENVIRONMENT) as Environment
  if (!(name in ENVIRONMENTS)) {
    throw new Error(`Unknown environment "${name}". Use one of: ${Object.keys(ENVIRONMENTS).join(', ')}`)
  }
  return name
}

export interface RuntimeConfig {
  managementApiUrl: string
  gatewayUrl: string
  oauthIssuer: string
  oauthClientId: string
  dashboardUrl: string
  region: Region
}

// Precedence per URL: per-URL env var > selected environment preset.
export function resolveConfig(region?: string): RuntimeConfig {
  const env = ENVIRONMENTS[selectEnvironment()]
  const resolvedRegion = (region ?? process.env.FINGERPRINT_REGION ?? 'us') as Region
  return {
    managementApiUrl: process.env.FINGERPRINT_MANAGEMENT_API_URL ?? env.managementApiUrl,
    gatewayUrl: process.env.FINGERPRINT_GATEWAY_URL ?? env.gatewayUrl,
    oauthIssuer: process.env.FINGERPRINT_OAUTH_ISSUER ?? env.oauthIssuer,
    oauthClientId: process.env.FINGERPRINT_OAUTH_CLIENT_ID ?? env.oauthClientId,
    dashboardUrl: process.env.FINGERPRINT_DASHBOARD_URL ?? env.dashboardUrl,
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
