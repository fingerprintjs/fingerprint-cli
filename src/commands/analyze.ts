import { resolve } from 'node:path'
import { pullTraffic, HIGH_SUSPECT } from '../api/events.js'
import { summarizeTraffic, suggest, verifiesServerSide, signals, type Suggestion } from '../wizard/traffic.js'
import { applyTrafficStep, SERVER_VERIFICATION_STEP } from '../wizard/runner.js'
import { settleSession } from './integrate.js'
import { log } from '../wizard/log.js'
import { color } from '../utils/color.js'
import { select } from '../utils/prompt.js'
import { requireAuth } from '../utils/session.js'
import { isCi } from '../utils/ci.js'
import { addRunProperties, recordWizardStep } from '../analytics/track.js'

// `fingerprint analyze` — count the workspace's suspicious identification events over the window
// (bad bots, high Suspect Scores: filtered by the API, so the counts are whole), sample the rest
// evenly across it for shares and replays, say which pages stand out and what to do about them,
// then offer to let the integrate agent apply a suggestion. Only aggregates are printed; never an
// event, visitor id or IP.
export async function analyzeCommand(opts: { days?: number; path?: string; max?: number; json?: boolean } = {}) {
  const auth = requireAuth()
  if (!auth.serverApiKey) throw new Error('No Server API key found. Run `fingerprint login` again.')
  const days = opts.days ?? 7
  const max = opts.max ?? 1000
  const root = resolve(opts.path ?? process.cwd())
  const end = new Date()
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)

  const pull = await pullTraffic({ serverApiKey: auth.serverApiKey, region: auth.region, start, end, max })
  const summary = summarizeTraffic(pull)
  const repo = { verifiesServerSide: verifiesServerSide(root) }
  const suggestions = suggest(summary, repo, { steps: { serverVerification: SERVER_VERIFICATION_STEP }, days })
  addRunProperties({
    analyze_events: summary.sampled,
    analyze_bad_bots: summary.badBots,
    analyze_pages: summary.pages.length,
    analyze_suggestions: suggestions.length,
  })

  if (opts.json) {
    const plain = suggestions.map(({ step: _step, activity: _activity, ...s }) => s)
    console.log(JSON.stringify({ workspace: auth.workspaceId, region: auth.region, days, ...summary, repo, suggestions: plain }, null, 2))
    return
  }

  const plus = (n: number, truncated: boolean) => (truncated ? `${n}+` : String(n))
  log.heading('analyze')
  log.step('Traffic')
  log.kv('Workspace', `${auth.workspaceId} ${color.dim(`(${auth.region})`)}`)
  log.kv('Window', `last ${days} day${days === 1 ? '' : 's'}`)
  log.kv(
    'Events',
    summary.sampleComplete
      ? `${summary.sampled} on ${summary.pages.length} page${summary.pages.length === 1 ? '' : 's'}`
      : `${summary.sampled} sampled evenly across the window ${color.dim(`(pass --max for more)`)}`
  )
  if (summary.sampled === 0 && summary.badBots === 0) {
    log.line()
    log.info(color.dim('No identification events yet. Open a page with the agent installed, then run this again.'))
    log.end()
    return
  }
  log.kv(
    'Suspicious',
    `${plus(summary.badBots, summary.badBotsTruncated)} bad bots, ${plus(summary.highSuspect, summary.highSuspectTruncated)} with Suspect Score ${HIGH_SUSPECT}+ ${color.dim('(whole window)')}`
  )

  const flagged = summary.pages.filter((p) => signals(p) > 0)
  log.line()
  if (!flagged.length) {
    log.info(color.dim('No page had bad bots, high Suspect Scores or replayed events.'))
  } else {
    const width = Math.max(...flagged.map((p) => p.path.length), 4)
    log.info(color.dim(`${'page'.padEnd(width)}  ${'bad bots'.padStart(8)}  ${'suspect'.padStart(7)}  ${'replayed'.padStart(8)}  ${'sampled'.padStart(7)}  bot share`))
    for (const p of flagged.slice(0, 15)) {
      const share = p.sampled >= 10 ? `${Math.round((100 * p.sampledBadBots) / p.sampled)}%` : color.dim('—')
      const bots = p.badBots ? color.yellow(String(p.badBots).padStart(8)) : String(p.badBots).padStart(8)
      log.info(`${p.path.padEnd(width)}  ${bots}  ${String(p.highSuspect).padStart(7)}  ${String(p.replayed).padStart(8)}  ${String(p.sampled).padStart(7)}  ${share}`)
    }
    if (flagged.length > 15) log.info(color.dim(`… ${flagged.length - 15} more pages with signals`))
    if (!summary.sampleComplete) log.info(color.dim('bad bots and suspect are whole-window counts; replayed and bot share come from the sample'))
  }
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
