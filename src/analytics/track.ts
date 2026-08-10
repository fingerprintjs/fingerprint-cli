import { ManagementClient } from '../api/management.js'
import { getAuthState } from '../auth/tokenStore.js'

// Runs as the command exits, so this is how long a bad network delays the prompt.
const TIMEOUT_MS = 1000

// Explicit call sites and the command hook can name the same thing, so each value reports once.
const sent = new Set<string>()

// Relayed through the Management API because the Amplitude key can't ship in the binary.
export async function trackCommand(command: string): Promise<void> {
  if (sent.has(command)) return
  if (!getAuthState()?.managementApiKey) return
  sent.add(command)

  try {
    await new ManagementClient().request('/analytics/events', {
      method: 'POST',
      body: JSON.stringify({ event: 'cli_command_run', properties: { command } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    // Never surface telemetry failures.
  }
}
