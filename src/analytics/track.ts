import { ManagementClient } from '../api/management.js'
import { getAuthState } from '../auth/tokenStore.js'

// Runs as the command exits, so this is how long a bad network can delay the prompt coming back.
const TIMEOUT_MS = 1000

// The Amplitude key can't ship in a binary that runs on someone else's machine, so this goes
// through the Management API, which forwards server-side and attributes the event to the workspace
// the key is scoped to.
export async function trackCommand(command: string): Promise<void> {
  if (!getAuthState()?.managementApiKey) return

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
