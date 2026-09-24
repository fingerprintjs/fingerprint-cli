import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getAuthState } from '../auth/tokenStore.js'

// Which custom subdomain a project chose, so a later `fingerprint integrate` can pick the setup up
// where it stopped instead of restarting the onboarding. Only the choice is stored (workspace,
// project, hostname); the subdomain's state always comes from the API. Kept under the user's
// config dir, never inside the project, and removed once the endpoint is configured.
export interface PendingSubdomainSetup {
  workspaceId: string
  root: string
  hostname: string
  updatedAt: string
}

const setupsPath = join(homedir(), '.config', 'fingerprint', 'subdomain-setups.json')

export function pendingSubdomainSetup(root: string): PendingSubdomainSetup | undefined {
  const key = keyFor(root)
  return key ? readAll()[key] : undefined
}

export function savePendingSubdomainSetup(root: string, hostname: string): void {
  const key = keyFor(root)
  if (!key) return
  const all = readAll()
  all[key] = { workspaceId: key.split('\n')[0], root: key.split('\n')[1], hostname, updatedAt: new Date().toISOString() }
  writeAll(all)
}

export function clearPendingSubdomainSetup(root: string): void {
  const key = keyFor(root)
  if (!key) return
  const all = readAll()
  if (!(key in all)) return
  delete all[key]
  writeAll(all)
}

function keyFor(root: string): string | undefined {
  const workspaceId = getAuthState()?.workspaceId
  if (!workspaceId) return undefined
  return `${workspaceId}\n${realpathSync(root)}`
}

function readAll(): Record<string, PendingSubdomainSetup> {
  if (!existsSync(setupsPath)) return {}
  try {
    return JSON.parse(readFileSync(setupsPath, 'utf8'))
  } catch {
    return {}
  }
}

function writeAll(all: Record<string, PendingSubdomainSetup>): void {
  mkdirSync(join(homedir(), '.config', 'fingerprint'), { recursive: true, mode: 0o700 })
  writeFileSync(setupsPath, JSON.stringify(all, null, 2), { mode: 0o600 })
}
