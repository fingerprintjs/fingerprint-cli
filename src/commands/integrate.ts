import { resolve } from 'node:path'
import { analyzeRepo, printAnalysis } from '../wizard/detect.js'
import { getFreshAccessToken, withoutLoginHint } from '../auth/refresh.js'
import { integrateProject } from '../wizard/runner.js'
import { log, printFailure } from '../wizard/log.js'
import { requireAuth } from '../utils/session.js'
import { addRunProperties, track } from '../analytics/track.js'

export async function integrateCommand(
  opts: { path?: string; analyze?: boolean; yes?: boolean; skipHeading?: boolean; chained?: boolean } = {}
) {
  const root = resolve(opts.path ?? process.cwd())

  const analysis = analyzeRepo(root)
  // Apply when curated skills match, or — as a fallback — whenever we detected a frontend/backend
  // stack at all (the docs-based integration handles stacks without a skill).
  const willApply = Boolean(analysis.skills.length || analysis.frontend || analysis.backend) && !opts.analyze

  // Applying provisions real workspace keys and edits files, so it needs an authenticated user (the
  // workspace is fixed at login). Gate before the phase badge and any other output: a dead session
  // means the integrate phase never starts, so it shouldn't announce itself first.
  // (`--analyze` is a read-only report and stays available to logged-out users.)
  if (willApply && !(await settleSession())) return

  // Every apply reports here, invoked or chained. `cli_command_run` misses the chained ones
  // entirely — commander never dispatched them — so this is the one place the real integrate
  // count lives. The detected stack rides along: which frameworks people actually point this at
  // is what decides where the next curated skill goes. Framework/skill ids only — never paths.
  const stack = {
    chained: Boolean(opts.chained),
    frontend: analysis.frontend?.framework ?? '',
    backend: analysis.backend?.framework ?? '',
    skills: analysis.skills.join(','),
    monorepo: analysis.monorepo,
    app_count: analysis.apps.length,
  }

  // Awaited, not fired and forgotten: what follows blocks the event loop (a sync `git clone` for the
  // skills cache, package installs), and a request that hasn't been written by then never goes out.
  if (willApply) {
    await track('cli_integrate_started', stack)
  } else {
    // Where onboarding dead-ends: signed up, chained into integrate, applied nothing.
    await track('cli_integrate_skipped', {
      ...stack,
      reason: opts.analyze ? 'analyze_only' : analysis.apps.length ? 'no_supported_framework' : 'no_apps_found',
    })
  }

  // Phase badge opens the integrate sequence (analyze → apply). Callers that already printed it
  // (e.g. login chaining into integrate) pass `skipHeading`.
  if (!opts.skipHeading) log.heading('integrate')

  printAnalysis(analysis)

  if (!willApply) {
    if (!analysis.frontend && !analysis.backend) {
      printFailure({
        title: 'No supported app to integrate',
        reason: 'No frontend or backend framework we can wire up was found in this repo.',
        recoveries: [
          { command: 'fingerprint integrate --path <dir>', description: 'point at an app directory' },
          { command: 'fingerprint --help', description: 'see available commands' },
        ],
      })
    }
    return
  }

  // Provision keys + apply the integration for this repo, then offer the missing half of the
  // stack (if any) and point at the skills plugin for the rest of Get Started.
  const outcome = await integrateProject(root, { yes: opts.yes })
  // Rides cli_command_run (new event names need a Management API allowlist entry; properties
  // don't) — the completion pair to cli_integrate_started.
  addRunProperties({ integrate_status: outcome })
}

// Settle the session before anything provisions keys or edits files, refreshing the access token if
// it's spent. A missing session and a refresh that can't be renewed have the same fix, so they share
// one failure block — printed here rather than thrown, since the top-level handler prints a bare
// message with none of the recovery hints.
async function settleSession(): Promise<boolean> {
  try {
    requireAuth()
    await getFreshAccessToken()
    return true
  } catch (err) {
    // Report the specific reason — missing session, expired session, or an unreachable login service,
    // which is a network problem no amount of logging in will fix.
    const message = err instanceof Error ? err.message : String(err)
    printFailure({
      title: 'Can’t start the integration',
      reason: `${withoutLoginHint(message)}\nApplying provisions API keys for your workspace, so it needs a live session.`,
      recoveries: [
        { command: 'fingerprint login', description: 'sign in, then integrate runs automatically' },
        { command: 'fingerprint integrate --analyze', description: 'see the detected stack without signing in' },
      ],
    })
    process.exitCode = 1
    return false
  }
}
