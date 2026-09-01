import { randomUUID } from 'node:crypto'
import { ManagementClient } from '../api/management.js'
import { getAuthState, type AuthState } from '../auth/tokenStore.js'
import { debugLog } from '../utils/log-file.js'

// How long a bad network can delay the run. The timer starts when track() is called, not when the
// request goes out, so callers must await rather than fire and forget: a caller that starts blocking
// work first burns the whole budget before the socket is ever written, and the event is lost with
// nothing sent and nothing logged server-side.
const TIMEOUT_MS = 1000

// The events the Management API accepts without a key, mirroring its own allow-list. `integrate`
// provisions keys, so it can never be one of them.
const ANONYMOUS_EVENTS = new Set(['cli_run_started', 'cli_command_run', 'cli_auth_intent_selected'])

// One id per process. A run emits several events — the command, the intent answer, the chained
// integrate — and this is what stitches them back into a single invocation.
const runId = randomUUID()

// `logout` drops the credential its own event is sent with, so it pins a snapshot before clearing
// instead of every call site passing auth through.
let pinnedAuth: AuthState | null | undefined
export function pinAuthForTracking(auth: AuthState | null): void {
  pinnedAuth = auth
}

// Context a command discovers mid-run that belongs on this run's events. A detail with no event of
// its own — which key type was asked for, say — rides on the events there are. The Management API
// allowlists properties per event, and strips unknown ones without erroring, so anything added here
// needs adding there too or it vanishes silently.
let runProperties: Record<string, unknown> = {}
export function addRunProperties(properties: Record<string, unknown>): void {
  runProperties = { ...runProperties, ...properties }
}

// Option names only. Values carry paths and keys, and never leave the machine.
function cliFlags(): string {
  const names = process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => a.slice(2).split('=')[0])
  return [...new Set(names)].sort().join(',')
}

// Relayed through the Management API because the Amplitude key can't ship in the binary. A run with
// no key relays through the unauthenticated route so runs that never sign in still get counted.
export async function track(event: string, properties: Record<string, unknown> = {}): Promise<void> {
  const auth = pinnedAuth ?? getAuthState()
  const authenticated = Boolean(auth?.managementApiKey)

  // Only events that can happen before there is a workspace are accepted unauthenticated, and the
  // Management API rejects the rest. Dropping them here keeps a guaranteed 400 off the wire.
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
    // Never surface telemetry failures to the user, but leave a trail: a dropped event is otherwise
    // indistinguishable from one that was never fired.
    debugLog(`analytics: dropped ${event} (${err instanceof Error ? err.message : String(err)})`)
  }
}
