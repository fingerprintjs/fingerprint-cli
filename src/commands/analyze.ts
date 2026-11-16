import { resolve } from 'node:path'
import { searchEvents } from '../api/events.js'
import { summarizeTraffic, suggest, verifiesServerSide, type Suggestion } from '../wizard/traffic.js'
import { applyTrafficStep, SERVER_VERIFICATION_STEP } from '../wizard/runner.js'
import { settleSession } from './integrate.js'
import { log } from '../wizard/log.js'
import { color } from '../utils/color.js'
import { select } from '../utils/prompt.js'
import { requireAuth } from '../utils/session.js'
import { isCi } from '../utils/ci.js'
import { addRunProperties, recordWizardStep } from '../analytics/track.js'

// `fingerprint analyze` — read the workspace's recent identification events, say what each page
// saw (bots, VPN, replays, low confidence) and what to do about it, then offer to let the
// integrate agent apply a suggestion. Only aggregates are printed; never an event, visitor id or IP.
export async function analyzeCommand(opts: { days?: number; path?: string; max?: number; json?: boolean } = {}) {
  const auth = requireAuth()
  if (!auth.serverApiKey) throw new Error('No Server API key found. Run `fingerprint login` again.')
  const days = opts.days ?? 7
  const max = opts.max ?? 1000
  const root = resolve(opts.path ?? process.cwd())
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const events = await searchEvents({ serverApiKey: auth.serverApiKey, region: auth.region, start, max })
  const summary = summarizeTraffic(events)
  const repo = { verifiesServerSide: verifiesServerSide(root) }
  const suggestions = suggest(summary, repo, { serverVerification: SERVER_VERIFICATION_STEP })
  addRunProperties({ analyze_events: summary.events, analyze_pages: summary.pages.length, analyze_suggestions: suggestions.length })

  if (opts.json) {
    const plain = suggestions.map(({ step: _step, activity: _activity, ...s }) => s)
    console.log(JSON.stringify({ workspace: auth.workspaceId, region: auth.region, days, ...summary, repo, suggestions: plain }, null, 2))
    return
  }

  log.heading('analyze')
  log.step('Traffic')
  log.kv('Workspace', `${auth.workspaceId} ${color.dim(`(${auth.region})`)}`)
  log.kv('Window', `last ${days} day${days === 1 ? '' : 's'}${summary.events >= max ? color.dim(` · newest ${max} events`) : ''}`)
  log.kv('Events', `${summary.events} on ${summary.pages.length} page${summary.pages.length === 1 ? '' : 's'}`)
  if (summary.events === 0) {
    log.line()
    log.info(color.dim('No identification events yet. Open a page with the agent installed, then run this again.'))
    log.end()
    return
  }

  log.line()
  const width = Math.max(...summary.pages.map((p) => p.path.length), 4)
  log.info(color.dim(`${'page'.padEnd(width)}  ${'events'.padStart(7)}  ${'bad bots'.padStart(8)}  ${'vpn'.padStart(5)}  ${'replayed'.padStart(8)}  visitors`))
  for (const p of summary.pages.slice(0, 15)) {
    const pct = (n: number) => `${Math.round((100 * n) / p.events)}%`.padStart(5)
    const bots = p.badBots ? color.yellow(`${p.badBots} ${pct(p.badBots)}`.padStart(8)) : `${p.badBots} ${pct(p.badBots)}`.padStart(8)
    log.info(`${p.path.padEnd(width)}  ${String(p.events).padStart(7)}  ${bots}  ${pct(p.vpn)}  ${String(p.replayed).padStart(8)}  ${p.visitors}`)
  }
  if (summary.pages.length > 15) log.info(color.dim(`… ${summary.pages.length - 15} more`))
  log.line()
  log.kv('Server-side', repo.verifiesServerSide ? color.green('this repo verifies events with the Server API') : color.yellow('this repo does not read events from the Server API'))

  log.step(suggestions.length ? `Suggestions (${suggestions.length})` : 'Suggestions')
  if (!suggestions.length) log.info(color.dim('Nothing stands out in this window.'))
  suggestions.forEach((s, i) => {
    if (i) log.line()
    log.info(`${color.bold(`${i + 1}. ${s.title}`)}`)
    log.info(`   ${s.detail}`)
    log.info(`   ${color.dim(s.docs)}`)
  })
  log.end()

  await offerToApply(root, suggestions)
}

// The suggestions the agent can act on, one at a time, until the user stops. Headless runs are a
// report only: applying edits files and needs a live gateway session.
async function offerToApply(root: string, suggestions: Suggestion[]): Promise<void> {
  const pending = suggestions.filter((s) => s.step)
  if (isCi() || !pending.length) return
  let applied = 0
  while (pending.length) {
    const pick = await select<Suggestion | 'stop'>({
      message: 'Apply a suggestion with the agent? (edits this repo)',
      choices: [
        ...pending.map((s) => ({ name: s.title, value: s })),
        { name: applied ? 'Done for now' : 'Not now', value: 'stop' },
      ],
    })
    if (pick === 'stop') break
    recordWizardStep('analyze_apply')
    // Checked at the first pick, not before the report: reading events never needs the gateway.
    if (!applied && !(await settleSession())) break
    const outcome = await applyTrafficStep(root, pick.step!, pick.activity ?? 'Applying the suggestion')
    if (outcome === 'failed') break
    pending.splice(pending.indexOf(pick), 1)
    applied++
  }
  addRunProperties({ analyze_applied: applied })
}
