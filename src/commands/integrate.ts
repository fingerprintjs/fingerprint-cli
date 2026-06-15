import { resolve } from 'node:path'
import { analyzeRepo, formatAnalysis } from '../wizard/detect.js'
import { log } from '../wizard/log.js'
import { provisionForRepo } from '../wizard/provision.js'
import { applyIntegration } from '../wizard/runner.js'
import { requireAuth } from '../utils/session.js'

export async function integrateCommand(opts: { path?: string; analyze?: boolean; yes?: boolean } = {}) {
  const root = resolve(opts.path ?? process.cwd())

  const analysis = analyzeRepo(root)
  // Apply when a curated skill matches, or — as a fallback — whenever we detected a frontend/backend
  // stack at all (the docs-based integration handles stacks without a skill).
  const willApply = Boolean(analysis.skillId || analysis.frontend || analysis.backend) && !opts.analyze

  // Applying provisions real workspace keys and edits files, so it needs an authenticated user
  // with an active workspace. Gate before any output or side effects. (`--analyze` is a read-only
  // report and stays available to logged-out users.)
  if (willApply) {
    const auth = requireAuth()
    if (!auth.currentSubscriptionId) {
      throw new Error('No active workspace. Run: fingerprint login (or: fingerprint workspace use <id>)')
    }
  }

  console.log(formatAnalysis(analysis))

  if (!willApply) return

  // Step: set up env vars (provision keys + region into each app's env file).
  log.step('Set up environment variables')
  await provisionForRepo(root)

  // Step: ask to apply, then run the agent.
  await applyIntegration(root, { yes: opts.yes })
}
