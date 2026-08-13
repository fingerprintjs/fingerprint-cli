import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AuthState {
  // OAuth access token (JWT) from the MCP auth server login. This is the Bearer credential the LLM
  // gateway verifies against the auth server's JWKS. Short-lived; see wizard/llm.ts.
  accessToken: string
  // OAuth refresh token from the same login (requires the `offline_access` scope). The access token
  // above expires quickly, so this is what keeps a session alive across runs without sending the user
  // back through the browser. The auth server rotates it on every use — always persist the new one.
  // Optional: absent from state written before refresh support, and if the server declines to issue one.
  refreshToken?: string
  // Server (Secret) API key from the login bundle, used server-side for backend event verification.
  // Handed to backend integrations as-is so the CLI never has to mint one.
  serverApiKey: string
  // Workspace-scoped Management API key (extracted from the access token's `sub`), used as the Bearer
  // for the public Management API — NOT for the gateway. Kept separately from the access token.
  managementApiKey: string
  // The subscription the key is scoped to (the `sub_…` id), and its agent region ('us'|'eu'|'ap')
  // for app env config.
  workspaceId: string
  region: string
  // Signed-in user's email, from the login id_token. Optional: absent from state written before
  // email support, and when the issuer returns no email claim.
  email?: string
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
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  // Create the file already restricted rather than chmod-ing after the fact: this holds the access
  // token, the refresh token and both API keys, and writing first would leave it umask-readable
  // (usually 0644) until the chmod landed. The chmod still runs to tighten a file that already
  // existed, since `mode` only applies at creation.
  writeFileSync(configPath, JSON.stringify(state, null, 2), { mode: 0o600 })
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
