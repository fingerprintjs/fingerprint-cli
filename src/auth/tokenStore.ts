import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AuthState {
  accessToken: string
  refreshToken?: string
  userId?: string
  currentSubscriptionId?: string
  apiUrl: string
  region: string
}

const configDir = join(homedir(), '.config', 'fingerprint')
const configPath = join(configDir, 'auth.json')

// In-memory auth used for CI/headless runs (e.g. `--api-key`). When set it takes precedence over
// the on-disk file and is never persisted, so a CI key doesn't overwrite a developer's login.
let sessionOverride: AuthState | null = null

export function setSessionOverride(state: AuthState): void {
  sessionOverride = state
}

export function getAuthState(): AuthState | null {
  if (sessionOverride) return sessionOverride
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
  // Keep CI's in-memory session in memory; only persist real logins.
  if (sessionOverride) sessionOverride = next
  else saveAuthState(next)
  return next
}
