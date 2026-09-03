import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DetectedApp, RepoAnalysis } from './detect.js'
import { getAuthState } from '../auth/tokenStore.js'
import { resolveConfig } from '../config/config.js'
import { log } from './log.js'
import { color } from '../utils/color.js'

// The app's own run command, read from the repo: the `dev` script if present, else `start`, phrased
// for the detected package manager. Python apps have no package.json, so the framework decides.
function devCommand(app: DetectedApp): string | undefined {
  if (app.language === 'python') {
    switch (app.framework) {
      case 'fastapi':
        return 'uvicorn main:app --reload'
      case 'django':
        return 'python manage.py runserver'
      case 'flask':
        return 'flask run'
      default:
        return undefined
    }
  }
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

// The user's own Get Started page. The dashboard is the checklist and the judge: it marks a step
// complete only when it observes the event, so the CLI never keeps its own done/not-done state.
function getStartedUrl(): string {
  const workspaceId = getAuthState()?.workspaceId
  const base = resolveConfig().dashboardUrl
  return workspaceId ? `${base}/workspaces/${workspaceId}/get-started` : base
}

// How to verify, and nothing else — styled like every other section (◇ header, rail, aligned
// labels, └ to close the run). The CLI can't confirm anything itself in this release, and the later
// checklist steps only make sense once the first event exists — so: the one action that produces
// evidence (frontend present), or the one thing that makes evidence possible (backend only).
export function printHowToVerify(analysis: RepoAnalysis): void {
  const apps = analysis.apps.filter((a) => a.role !== 'unknown')
  const sendsEvents = apps.some((a) => a.role === 'frontend' || a.role === 'fullstack')
  const url = color.cyan(getStartedUrl())

  log.step('Verify it works')
  if (!sendsEvents) {
    log.info('This backend verifies events sent by a frontend — there is nothing to see until one exists.')
    log.line()
    log.kv('Next', `${color.bold('fingerprint integrate --path <frontend-dir>')} ${color.dim('(in your frontend repo)')}`)
    log.kv('Check', 'your Get Started page — follow your progress there')
    log.kv('', url)
    log.end()
    return
  }

  log.info(`Start ${apps.length > 1 ? 'the apps' : 'the app'} and trigger identification once — that sends your first event.`)
  log.line()
  apps.forEach((app, i) => {
    const where = app.rel === '.' ? '' : color.dim(` (in ${app.rel})`)
    log.kv(i === 0 ? 'Run' : '', `${color.bold(devCommand(app) ?? 'start the app')}${where}`)
  })
  log.kv('Check', 'your Get Started page — step 1 turns green when the event arrives')
  log.kv('', url)
  log.end()
}
