import { resolve } from 'node:path'
import { analyzeRepo, formatAnalysis } from '../wizard/detect.js'
import { integrateProject } from '../wizard/runner.js'
import { requireAuth } from '../utils/session.js'

export async function integrateCommand(opts: { path?: string; analyze?: boolean; yes?: boolean } = {}) {
  const root = resolve(opts.path ?? process.cwd())

  const analysis = analyzeRepo(root)
  // Apply when curated skills match, or — as a fallback — whenever we detected a frontend/backend
  // stack at all (the docs-based integration handles stacks without a skill).
  const willApply = Boolean(analysis.skills.length || analysis.frontend || analysis.backend) && !opts.analyze

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

  // Provision keys + apply the integration for this repo, then offer to set up other projects
  // (a separate frontend/backend, or any other repo) based on what this one covers.
  await integrateProject(root, { yes: opts.yes })
}
