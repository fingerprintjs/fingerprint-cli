import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DetectedApp, RepoAnalysis } from './detect.js'
import { log } from './log.js'
import { color } from '../utils/color.js'

// The app's own run command (dev script preferred), phrased for its package manager. Python apps
// have no package.json — the caller falls back to generic wording.
function devCommand(app: DetectedApp): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(app.dir, 'package.json'), 'utf8'))
    const script = pkg.scripts?.dev ? 'dev' : pkg.scripts?.start ? 'start' : undefined
    if (!script) return undefined
    switch (app.packageManager) {
      case 'pnpm':
        return `pnpm ${script}`
      case 'yarn':
        return `yarn ${script}`
      case 'bun':
        return `bun run ${script}`
      default:
        return `npm run ${script}`
    }
  } catch {
    return undefined
  }
}

// Closing summary after a completed run, in the dashboard's Get Started order. The agent is told
// not to print run/verify instructions (they'd land before the packages are even installed), so
// this is the one place that leads the user from "code applied" to "first event seen" to the
// Server API step. Text only — no event polling in this release.
export function printNextSteps(analysis: RepoAnalysis): void {
  const apps = analysis.apps.filter((a) => a.role !== 'unknown')
  const hasBackend = apps.some((a) => a.role === 'backend' || a.role === 'fullstack')
  log.step('Next steps — Get Started')
  log.info('1. Run the app and check your first event:')
  for (const app of apps) {
    const where = app.rel === '.' ? '' : color.dim(` (in ${app.rel})`)
    log.info(`   ${color.bold(devCommand(app) ?? 'start the app')}${where}`)
  }
  log.info(`   then load the page and open ${color.bold('https://dashboard.fingerprint.com')} → Events. A new event means it works.`)
  log.info('2. Access detailed insights via the Server API:')
  log.info(
    hasBackend
      ? '   your backend verifies each event server-side — explore the full Smart Signals set from there.'
      : `   verify events server-side in your backend: ${color.bold('fingerprint integrate --path <backend-dir>')}`
  )
  log.info('3. Protect against ad blockers — serve the agent from your own domain (custom subdomain / proxy).')
  log.line()
  log.info(color.dim('Beyond the basics (optional): rules · tagging · request filtering · team invites.'))
  log.kv('Docs', color.dim('https://docs.fingerprint.com'))
}
