import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AuthState {
  // OAuth access token (JWT) from the MCP auth server login. This is the Bearer credential the LLM
  // gateway verifies against the auth server's JWKS. Short-lived; see wizard/llm.ts.
  accessToken: string
  // Server (Secret) API key from the login bundle, used server-side for backend event verification.
  // Handed to backend integrations as-is so the CLI never has to mint one.
  serverApiKey: string
  // Workspace-scoped Management API key (extracted from the access token's `sub`), used as the Bearer
  // for the public Management API — NOT for the gateway. Kept separately from the access token.
  managementApiKey: string
  // The workspace the key is scoped to, and its agent region ('us'|'eu'|'ap') for app env config.
  workspaceId: string
  region: string
  // Public Management API base URL for this login's environment (kept so the CLI keeps talking to the
  // same environment the user logged into).
  managementApiUrl: string
}

const configDir = join(homedir(), '.config', 'fingerprint')
const configPath = join(configDir, 'auth.json')

export function getAuthState(): AuthState | null {
  if (!existsSync(configPath)) return null
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as AuthState
  } catch {
    return null
  }
}

export function saveAuthState(state: AuthState): void {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(configPath, JSON.stringify(state, null, 2))
  chmodSync(configPath, 0o600)
}

export function clearAuthState(): void {
  if (existsSync(configPath)) rmSync(configPath)
}

export function updateAuthState(patch: Partial<AuthState>): AuthState | null {
  const current = getAuthState()
  if (!current) return null
  const next = { ...current, ...patch }
  saveAuthState(next)
  return next
}
