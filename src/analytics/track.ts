import { ManagementClient } from '../api/management.js'
import { getAuthState } from '../auth/tokenStore.js'

// Runs as the command exits, so this is how long a bad network delays the prompt.
const TIMEOUT_MS = 1000

// Explicit call sites and the command hook can name the same thing, so each value reports once.
const sent = new Set<string>()

// How the command was reached, kept apart from `command` so a query for one command catches
// every route to it.
export type Trigger = 'typed' | 'prompt' | 'chain'

// Relayed through the Management API because the Amplitude key can't ship in the binary.
// `auth` is a parameter so a caller about to drop the credential can pass its own snapshot.
export async function trackCommand(command: string, trigger: Trigger, auth = getAuthState()): Promise<void> {
  if (sent.has(command)) return
  if (!auth?.managementApiKey) return
  sent.add(command)

  try {
    await new ManagementClient({
      managementApiKey: auth.managementApiKey,
      managementApiUrl: auth.managementApiUrl,
    }).request('/analytics/events', {
      method: 'POST',
      body: JSON.stringify({ event: 'cli_command_run', properties: { command, trigger } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    // Never surface telemetry failures.
  }
}
