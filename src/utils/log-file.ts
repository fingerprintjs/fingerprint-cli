import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Verbose run log in the OS temp dir (not the user's repo, so it never pollutes their git).
// Mirrors PostHog's /tmp/posthog-wizard.log — a discardable troubleshooting trail for failed runs.
export const LOG_PATH = join(tmpdir(), 'fingerprint-wizard.log')

export function debugLog(line: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    // Logging must never break the CLI.
  }
}
