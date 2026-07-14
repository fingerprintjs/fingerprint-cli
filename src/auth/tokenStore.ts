import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AuthState {
  // Workspace-scoped Management API key (Bearer credential for the public Management API and the LLM
  // gateway). This is the only credential the CLI stores — no dashboard session / refresh token.
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
