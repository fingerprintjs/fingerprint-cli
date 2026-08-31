import { confirm } from '@inquirer/prompts'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeRepo, DetectedApp, RepoAnalysis } from './detect.js'
import { conventionFor } from './provision.js'
import { getAuthState } from '../auth/tokenStore.js'
import { serverApiUrl } from '../config/config.js'
import { log } from './log.js'
import { color } from '../utils/color.js'
import { Spinner } from './spinner.js'
import { autoYes, isCi } from '../utils/ci.js'
import { addRunProperties } from '../analytics/track.js'

// Post-integration verification: the run only counts once an identification call actually reached
// Fingerprint — evidence, not the agent's word. Cheap static checks first (key probe, env-var
// names), then guided run instructions, then a live wait for the first event. All Server API
// calls happen host-side with auth.serverApiKey; the secret never reaches the agent or the repo
// beyond what provisioning wrote.

const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 5 * 60 * 1000
// Search slightly behind "now" so an event sent while the checks were printing still counts.
const START_SKEW_MS = 60 * 1000
// Standalone `fingerprint verify` looks further back: the app may already be running.
export const STANDALONE_LOOKBACK_MS = 10 * 60 * 1000

interface FoundEvent {
  visitorId?: string
  timestamp?: number
}

// The most recent identification event since `sinceMs`, or undefined when there is none (an
// empty page, a bad key, and a network error all mean the same thing to a poll: keep waiting).
async function searchFirstEvent(secretKey: string, region: string, sinceMs: number): Promise<FoundEvent | undefined> {
  const url = new URL(`${serverApiUrl(region)}/events/search`)
  url.searchParams.set('limit', '1')
  url.searchParams.set('start', String(sinceMs))
  try {
    const res = await fetch(url, { headers: { 'Auth-API-Key': secretKey } })
    if (!res.ok) return undefined
    const body = (await res.json()) as {
      events?: Array<{ products?: { identification?: { data?: { visitorId?: string; timestamp?: number } } } }>
    }
    const data = body.events?.[0]?.products?.identification?.data
    return body.events?.length ? { visitorId: data?.visitorId, timestamp: data?.timestamp } : undefined
  } catch {
    return undefined
  }
}

// A secret key reused from a pre-existing .env is the one key we didn't mint or receive at login,
// so it can belong to another workspace or region — probe it with a single search call. A key from
// the login bundle is correct by construction and never reaches here.
export async function checkReusedSecretKey(key: string, region: string): Promise<void> {
  try {
    const res = await fetch(`${serverApiUrl(region)}/events/search?limit=1`, { headers: { 'Auth-API-Key': key } })
    if (res.ok) {
      log.info(`Reused secret key is valid in region "${region}".`)
      return
    }
    log.warn(
      `The secret key reused from .env is not valid in region "${region}" (HTTP ${res.status}) — it may belong to ` +
        'another workspace. Remove it from .env and re-run `fingerprint integrate` to provision the right one.'
    )
  } catch {
    log.warn('Could not validate the reused secret key (network) — server-side verification may fail if it belongs to another workspace.')
  }
}

const SOURCE_EXT = /\.(m?[jt]sx?|c[jt]s|vue|svelte|astro|py)$/
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', 'venv', '.venv'])

// Does any source file under `dir` mention `name`? Bounded so a huge repo can't stall the run;
// when the budget runs out we assume it's fine — a warning from a partial scan would be noise.
function sourceMentions(dir: string, name: string, budget = { files: 2000 }): boolean {
  for (const entry of readdirSync(dir)) {
    if (budget.files <= 0) return true
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
    const child = join(dir, entry)
    let stat
    try {
      stat = statSync(child)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      if (sourceMentions(child, name, budget)) return true
    } else if (SOURCE_EXT.test(entry)) {
      budget.files--
      try {
        if (readFileSync(child, 'utf8').includes(name)) return true
      } catch {
        /* unreadable — skip */
      }
    }
  }
  return false
}

// The agent was told which env-var names provisioning wrote; if the code never references them,
// the key can't reach the SDK at runtime. Static — catches the mismatch without running anything.
export function checkEnvVarNames(analysis: RepoAnalysis): void {
  for (const app of analysis.apps) {
    if (app.role === 'unknown') continue
    const conv = conventionFor(app)
    for (const name of [conv.publicVar, conv.secretVar]) {
      if (!name) continue
      // Only meaningful when provisioning actually wrote the file (it skips e.g. a missing secret).
      if (!existsSync(join(app.dir, conv.file))) continue
      if (sourceMentions(app.dir, name)) {
        log.info(color.dim(`${name} is referenced in ${app.rel} ✓`))
      } else {
        log.warn(`${name} is not referenced in ${app.rel} — the integration may read a different variable name.`)
      }
    }
  }
}

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

export function printRunInstructions(analysis: RepoAnalysis): void {
  log.info('Run the app to make your first identification call:')
  const fe = analysis.frontend
  const be = analysis.backend
  if (fe) {
    const where = fe.rel === '.' ? '' : color.dim(` (in ${fe.rel})`)
    log.info(`  ${color.bold(devCommand(fe) ?? 'start your dev server')}${where} — then open the app in your browser.`)
    log.info('  Loading the page triggers identification automatically.')
  }
  if (be) {
    const where = be.rel === '.' ? '' : color.dim(` (in ${be.rel})`)
    log.info(`  ${color.bold(devCommand(be) ?? 'start your server')}${where} — the protected endpoint verifies each event server-side.`)
  }
}

// Ranked by how often each one is the actual cause in the field.
function printTimeoutCauses(region: string): void {
  log.warn('No identification event arrived. Most likely causes, in order:')
  log.info('  1. The app was not running or the page was not loaded — start it, load the page, then run `fingerprint verify`.')
  log.info('  2. The Fingerprint provider/agent is not mounted on the page you loaded.')
  log.info('  3. An ad blocker blocked the request — retry in a private window with extensions off.')
  log.info(`  4. Region mismatch — this workspace lives in "${region}"; the client must send events there.`)
  log.info('  5. Non-Vite React setups: the CLI writes VITE_FINGERPRINT_PUBLIC_API_KEY; CRA/webpack apps use a different prefix and never see the key.')
}

// Confirm an identification event since `sinceMs` actually reached Fingerprint. Polls until one
// lands or `timeoutMs` passes; pass 0 to check exactly once (CI/scripts, where nobody is going to
// start a dev server). Returns undefined when the login carries no Server API key to search with.
export async function awaitFirstEvent(sinceMs: number, timeoutMs = POLL_TIMEOUT_MS): Promise<boolean | undefined> {
  const auth = getAuthState()
  if (!auth?.serverApiKey) return undefined
  const spinner = timeoutMs > 0 && process.stdout.isTTY && !isCi() ? new Spinner() : null
  spinner?.start('Waiting for your first identification event… start the app and load the page (Ctrl-C to stop waiting)')
  const deadline = Date.now() + timeoutMs
  try {
    for (;;) {
      const hit = await searchFirstEvent(auth.serverApiKey, auth.region, sinceMs)
      if (hit) {
        spinner?.stop()
        const ago = hit.timestamp ? Math.max(0, Math.round((Date.now() - hit.timestamp) / 1000)) : undefined
        log.success(
          `Identification received${hit.visitorId ? ` — visitor ${color.bold(hit.visitorId)}` : ''}${ago !== undefined ? color.dim(` (${ago}s ago)`) : ''}`
        )
        addRunProperties({ first_event_received: true, ...(ago !== undefined ? { first_event_latency_s: ago } : {}) })
        return true
      }
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
  } finally {
    spinner?.stop()
  }
  addRunProperties({ first_event_received: false })
  if (timeoutMs > 0) printTimeoutCauses(auth.region)
  return false
}

// The integrate flow's verification step: static checks, run instructions, then — when a human is
// present — the live wait for the first event. Non-interactive runs (CI, --yes, piped output) have
// nobody to start a dev server, so they get the manual pointer instead of a poll.
export async function verifyIntegration(root: string, opts: { yes?: boolean; reusedSecretKey?: string } = {}): Promise<void> {
  const analysis = analyzeRepo(root)
  const auth = getAuthState()
  log.step('Verify the integration')
  if (opts.reusedSecretKey && auth) await checkReusedSecretKey(opts.reusedSecretKey, auth.region)
  checkEnvVarNames(analysis)
  printRunInstructions(analysis)

  if (isCi() || opts.yes || autoYes() || !process.stdout.isTTY) {
    log.info('When the app is running, confirm the first event with: fingerprint verify')
    return
  }
  const wait = await confirm({ message: 'Wait here and confirm your first identification event now?', default: true })
  if (!wait) {
    log.info('Confirm later with: fingerprint verify')
    return
  }
  const got = await awaitFirstEvent(Date.now() - START_SKEW_MS)
  if (got === undefined) log.info('No Server API key from this login — load the app, then check for events in the dashboard.')
}

// Closing summary, mirroring the dashboard's Get Started page: the Quick start steps are the
// focus (install → detailed insights → ad blockers); "Beyond the basics" is optional and listed
// as such. Text only — the remaining steps live in the dashboard and later flows.
export function printNextSteps(analysis: RepoAnalysis): void {
  const hasBackend = analysis.apps.some((a) => a.role === 'backend' || a.role === 'fullstack')
  log.step('Next steps — Get Started')
  log.info('Quick start:')
  log.info(
    hasBackend
      ? '  • Access detailed insights — your backend verifies events server-side; explore the full Smart Signals set.'
      : '  • Access detailed insights — verify events server-side: add your backend with fingerprint integrate --path <dir>'
  )
  log.info('  • Protect against ad blockers — serve the agent from your own domain (custom subdomain / proxy).')
  log.line()
  log.info(color.dim('Beyond the basics (optional): build your first rule (Rules Engine) · tag events with'))
  log.info(color.dim('your data · protect your public API key (request filtering) · invite your team.'))
  log.line()
  log.kv('Dashboard', color.dim('https://dashboard.fingerprint.com'))
  log.kv('Docs', color.dim('https://docs.fingerprint.com'))
  log.end()
}
