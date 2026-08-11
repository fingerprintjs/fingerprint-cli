import { randomUUID } from 'node:crypto'
import { ManagementClient } from '../api/management.js'
import { getAuthState, type AuthState } from '../auth/tokenStore.js'

// Runs as the command exits, so this is how long a bad network delays the prompt.
const TIMEOUT_MS = 1000

// One id per process. A run emits several events — the command, the intent answer, the chained
// integrate — and this is what stitches them back into a single invocation.
const runId = randomUUID()

// `logout` drops the credential its own event is sent with, so it pins a snapshot before clearing
// instead of every call site passing auth through.
let pinnedAuth: AuthState | null | undefined
export function pinAuthForTracking(auth: AuthState | null): void {
  pinnedAuth = auth
}

// Option names only. Values carry paths and keys, and never leave the machine.
function cliFlags(): string {
  const names = process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => a.slice(2).split('=')[0])
  return [...new Set(names)].sort().join(',')
}

// Relayed through the Management API because the Amplitude key can't ship in the binary.
export async function track(event: string, properties: Record<string, unknown> = {}): Promise<void> {
  const auth = pinnedAuth ?? getAuthState()
  if (!auth?.managementApiKey) return

  try {
    await new ManagementClient({
      managementApiKey: auth.managementApiKey,
      managementApiUrl: auth.managementApiUrl,
    }).request('/analytics/events', {
      method: 'POST',
      body: JSON.stringify({ event, properties: { run_id: runId, cli_flags: cliFlags(), ...properties } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    // Never surface telemetry failures.
  }
}
