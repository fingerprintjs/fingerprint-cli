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

// The choices the user made in the wizard this run, in order, as one comma-separated property
// (`wizard_steps`): which step they picked, whether they resumed, how they handled DNS. Read
// together with `integrate_status` it says where a run went, without an event per click.
// Repeats collapse (checking DNS five times is one `dns_check`), and the list stops growing before
// the Management API's 256-character limit; a longer value would get the whole event rejected.
const WIZARD_STEPS_MAX = 256

export function recordWizardStep(step: string): void {
  const current = typeof runProperties.wizard_steps === 'string' ? runProperties.wizard_steps : ''
  if (current.split(',').at(-1) === step) return
  const steps = current ? `${current},${step}` : step
  if (steps.length > WIZARD_STEPS_MAX) return
  runProperties = { ...runProperties, wizard_steps: steps }
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
