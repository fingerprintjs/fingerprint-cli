import { randomUUID } from 'node:crypto'
import { ManagementClient } from '../api/management.js'
import { getAuthState, type AuthState } from '../auth/tokenStore.js'
import { debugLog } from '../utils/log-file.js'

const TIMEOUT_MS = 1000

// Mirrors the Management API's own allow-list for the keyless route.
const ANONYMOUS_EVENTS = new Set(['cli_run_started', 'cli_command_run', 'cli_auth_intent_selected'])

const runId = randomUUID()

// `logout` clears the credential before its own event is sent, so pin a snapshot first.
let pinnedAuth: AuthState | null | undefined
export function pinAuthForTracking(auth: AuthState | null): void {
  pinnedAuth = auth
}

// The Management API allowlists properties per event and silently drops unknown ones.
let runProperties: Record<string, unknown> = {}
export function addRunProperties(properties: Record<string, unknown>): void {
  runProperties = { ...runProperties, ...properties }
}

// Option names only, never their values.
function cliFlags(): string {
  const names = process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => a.slice(2).split('=')[0])
  return [...new Set(names)].sort().join(',')
}

export async function track(event: string, properties: Record<string, unknown> = {}): Promise<void> {
  const auth = pinnedAuth ?? getAuthState()
  const authenticated = Boolean(auth?.managementApiKey)

  if (!authenticated && !ANONYMOUS_EVENTS.has(event)) return

  try {
    const client = authenticated
      ? new ManagementClient({ managementApiKey: auth!.managementApiKey, managementApiUrl: auth!.managementApiUrl })
      : new ManagementClient({ anonymous: true })

    await client.request(authenticated ? '/analytics/events' : '/analytics/anonymous-events', {
      method: 'POST',
      body: JSON.stringify({
        event,
        properties: { run_id: runId, cli_flags: cliFlags(), ...runProperties, ...properties },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    debugLog(`analytics: dropped ${event} (${err instanceof Error ? err.message : String(err)})`)
  }
}
