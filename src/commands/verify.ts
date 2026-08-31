import { resolve } from 'node:path'
import { analyzeRepo } from '../wizard/detect.js'
import { awaitFirstEvent, checkEnvVarNames, printRunInstructions, STANDALONE_LOOKBACK_MS } from '../wizard/verify.js'
import { getAuthState } from '../auth/tokenStore.js'
import { log, printFailure } from '../wizard/log.js'
import { isCi } from '../utils/ci.js'

// Standalone re-run of the post-integration verification: for users who closed the terminal
// before starting their app, or who deployed and want to confirm events arrive from prod.
// Exit code carries the answer (0 = an event arrived, 1 = none found), so it's scriptable.
export async function verifyCommand(opts: { path?: string } = {}) {
  const root = resolve(opts.path ?? process.cwd())

  const auth = getAuthState()
  if (!auth?.managementApiKey) {
    printFailure({
      title: 'Can’t verify without a session',
      reason: 'Checking for identification events uses your workspace’s Server API key from login.',
      recoveries: [{ command: 'fingerprint login', description: 'sign in, then run fingerprint verify again' }],
    })
    process.exitCode = 1
    return
  }

  log.heading('verify')
  const analysis = analyzeRepo(root)
  checkEnvVarNames(analysis)
  printRunInstructions(analysis)

  // The app may already be running (or deployed), so look back a window rather than from "now".
  const since = Date.now() - STANDALONE_LOOKBACK_MS

  // With a human on a live terminal, wait for the event; otherwise one immediate check (timeout 0)
  // so CI and scripts get a fast, unambiguous answer.
  const interactive = process.stdout.isTTY && !isCi()
  const found = await awaitFirstEvent(since, interactive ? undefined : 0)

  if (found === undefined) {
    log.warn('This login carries no Server API key — check for events in the dashboard instead.')
    process.exitCode = 1
    return
  }
  if (!found) {
    if (!interactive) log.warn(`No identification event in the last ${Math.round(STANDALONE_LOOKBACK_MS / 60000)} minutes.`)
    process.exitCode = 1
  }
}
