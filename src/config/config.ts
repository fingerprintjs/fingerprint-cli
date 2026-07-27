export type Region = 'us' | 'eu' | 'ap'
export type Environment = 'production' | 'staging'

interface EnvironmentUrls {
  // Private mgmt-api. Not used during login anymore (that's WorkOS OAuth now); kept for any direct
  // mgmt-api calls. No dashboard session is ever held.
  apiUrl: string
  // Public Management API the CLI drives with its workspace-scoped Management API key (create/list
  // API keys + environments). This is where all post-login work happens.
  managementApiUrl: string
  // Dashboard hosting the /cli-auth consent page WorkOS redirects to during OAuth. The Management key
  // minted there is only valid against the SAME environment, so these URLs must always come from one
  // preset — never mix them.
  dashboardUrl: string
  // Hosted Fingerprint LLM gateway (Cloudflare Worker) the agent SDK is pointed at, so end users
  // never need an Anthropic key. It authenticates callers by the WorkOS access token.
  gatewayUrl: string
  // WorkOS AuthKit OAuth issuer — the AuthKit domain of the WorkOS environment the CLI app lives in
  // (like MCP's `https://mcpauth.fpjs.io`), NOT `api.workos.com` (that's WorkOS's management API,
  // only called server-side by mgmt-api). Endpoints are discovered from
  // `<issuer>/.well-known/oauth-authorization-server`.
  oauthIssuer: string
  // Public OAuth client id registered in WorkOS for the CLI (PKCE, loopback redirect). Per-environment
  // because WorkOS clients are per-environment. Overridable via FINGERPRINT_OAUTH_CLIENT_ID.
  oauthClientId: string
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
    // MCP auth server (discovered from the MCP resource metadata). Endpoints come from
    // <issuer>/.well-known/oauth-authorization-server. Override via FINGERPRINT_OAUTH_ISSUER.
    oauthIssuer: 'https://mcpauth.fingerprint.com',
    // Public client registered via Dynamic Client Registration on the MCP auth server (test value).
    oauthClientId: 'client_01KYHSG8DC4YHTJGWRADHBZ24D',
  },
  staging: {
    apiUrl: 'https://mgmtapi.fpjs.sh',
    managementApiUrl: 'https://public-mgmtapi.fpjs.sh',
    dashboardUrl: 'https://dashboard.fpjs.sh',
    gatewayUrl: 'https://fingerprint-llm-gateway.elvo.workers.dev',
    // Staging has no MCP OAuth server of its own, so reuse the prod MCP auth server for login.
    // NOTE: the key it mints is PROD-scoped — it won't authenticate against the staging mgmt-api above.
    oauthIssuer: 'https://scientific-cat-58-staging.authkit.app',
    oauthClientId: 'client_01KYHMB30PPDR66CWY8BKVTZRX',
  },
}

// OAuth scopes the CLI requests. Kept to just `openid` — the WorkOS environment has no custom
// permissions/scopes defined, and requesting an undefined scope 400s the authorize call. The
// Management key travels in the token subject (not via scopes), and the LLM gateway accepts any valid
// token from the issuer (its scope check is unset). Add a real scope here later if we define one.
export const OAUTH_SCOPES = ['openid']

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
  oauthIssuer: string
  oauthClientId: string
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
    oauthIssuer: process.env.FINGERPRINT_OAUTH_ISSUER ?? env.oauthIssuer,
    oauthClientId: process.env.FINGERPRINT_OAUTH_CLIENT_ID ?? env.oauthClientId,
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
