#!/usr/bin/env node
import { Command } from 'commander'
import { login, signup, startAuth, logout, whoami } from './commands/auth.js'
import { keysCommand } from './commands/keys.js'
import { integrateCommand } from './commands/integrate.js'
import { getAuthState } from './auth/tokenStore.js'
import { hasUsableSession } from './auth/refresh.js'
import { setCiContext, isCi } from './utils/ci.js'
import { setVerbose } from './utils/verbose.js'
import { setInteractive } from './utils/interactive.js'
import { color } from './utils/color.js'
import { printFiglet } from './utils/figlet.js'
import { track } from './analytics/track.js'

const program = new Command()
program.name('fingerprint').description('Fingerprint CLI dashboard companion')

// Global flags shared by every command, used for headless/CI runs.
program
  .option('--ci', 'non-interactive: never prompt; auto-confirm and fail fast on missing input')
  .option('-y, --yes', 'skip confirmation prompts')
  .option('--verbose', "show the agent's individual steps (file reads, edits, tool calls)")
  .option('--interactive', 'ask before each file edit and package install (default: apply automatically)')

// Seed the CI/headless session from global flags before any command runs.
program.hook('preAction', () => {
  const opts = program.opts<{ ci?: boolean; yes?: boolean; verbose?: boolean; interactive?: boolean }>()
  const ci = Boolean(opts.ci) || process.env.CI === 'true'
  setCiContext({ ci, yes: Boolean(opts.yes) || ci })
  setVerbose(Boolean(opts.verbose))
  // Per-step prompting needs a human; never enable it in CI/headless runs.
  setInteractive(Boolean(opts.interactive) && !ci)
})

// An unrecognized command resolves through the default action, so it reaches the hook looking
// like a bare `fingerprint`.
let ranUnknownCommand = false

// Recorded here and reported once the run settles. postAction would be tidier but is skipped when
// the action throws, which lost exactly the commands worth measuring: integrate fails often enough
// in real use that `login` and `default` were going missing entirely.
let invokedCommand: string | undefined
program.hook('preAction', (_thisCommand, actionCommand) => {
  invokedCommand = actionCommand === program ? undefined : actionCommand.name()
})

// After the run settles, so `login` has written credentials by the time we look for a workspace.
async function reportRun(status: 'ok' | 'error'): Promise<void> {
  await track('cli_command_run', {
    command: invokedCommand ?? (ranUnknownCommand ? 'unknown' : 'default'),
    status,
  })
}

program
  .command('login')
  .description('Log in through the browser')
  .action(async () => login())
program
  .command('signup')
  .description('Create a Fingerprint account through the browser')
  .action(async () => signup())
program.command('logout').action(logout)
program.command('whoami').action(whoami)

program
  .command('keys')
  .description('Print an API key for the active workspace')
  .argument('[type]', 'key type: public | secret (prompts if omitted)')
  .action((type) => keysCommand(type))

program
  .command('integrate')
  .description('Analyze the current repo and apply the Fingerprint integration')
  .option('--path <dir>', 'repo to analyze (default: current directory)')
  .option('--analyze', 'only analyze; do not apply the integration')
  .option('--yes', 'skip the confirmation prompt')
  .option('--verbose', "show the agent's individual steps (file reads, edits, tool calls)")
  .option('--interactive', 'ask before each file edit and package install (default: apply automatically)')
  .action((opts) => {
    if (opts.verbose) setVerbose(true)
    if (opts.interactive && !isCi()) setInteractive(true)
    return integrateCommand({ path: opts.path, analyze: opts.analyze, yes: opts.yes })
  })

// Default command: `fingerprint` with no subcommand. Route by where the user is so the whole
// onboarding is one command (login → integrate, resuming from any point). Signup + workspace/region
// selection all happen in the browser during login, so by the time we're authenticated the workspace
// is already chosen.
async function defaultCommand(unknownCommand?: string) {
  // Registered subcommands are dispatched by commander before the default action runs, so any
  // positional that reaches here is an unrecognized command (typically a typo). Fail with a friendly
  // hint instead of commander's bare "too many arguments".
  if (unknownCommand) {
    // Reporting a typo as `default` would read as launcher usage, which is the opposite of what it is.
    ranUnknownCommand = true
    reportUnknownCommand(unknownCommand)
    return
  }

  const auth = getAuthState()

  // Welcome message: what Fingerprint does, what this CLI does about it, and where to go next.
  // Deliberately not a step list — the only step the user takes is answering the account prompt
  // below; signing up, picking a workspace and region all happen in the browser after that.
  printFiglet()
  console.log()
  console.log(color.brand('   Welcome to the Fingerprint CLI.'))
  console.log()
  console.log(color.dim('   Fingerprint identifies returning browsers and devices with a stable'))
  console.log(color.dim('   visitor ID. Smart Signals add device intelligence to help detect bots'))
  console.log(color.dim('   and suspicious activity.'))
  console.log()
  console.log(color.dim('   This CLI sets up Fingerprint end to end. It detects your stack, provisions'))
  console.log(color.dim('   API keys, and writes the integration into your code.'))
  console.log()
  // A stored key isn't a live session, so check the token too: otherwise an expired login announces
  // "Signed in" a few lines above the sign-in-required failure it's about to hit.
  console.log(
    auth?.managementApiKey && hasUsableSession()
      ? `   Signed in · workspace ${auth.workspaceId}`
      : '   Sign in or create an account to get started.'
  )
  console.log()
  const commands: [string, string][] = [
    ['fingerprint', 'this guided setup, start to finish'],
    ['fingerprint integrate', 'add Fingerprint to the repo in this directory'],
    ['fingerprint keys', 'print a public or secret API key'],
    ['fingerprint whoami', 'show the signed-in workspace'],
    ['fingerprint --help', 'every command and flag'],
  ]
  const width = Math.max(...commands.map(([name]) => name.length))
  console.log(color.dim('   Commands'))
  for (const [name, description] of commands) {
    console.log(`     ${name.padEnd(width)}  ${color.dim(description)}`)
  }
  console.log()

  if (!auth?.managementApiKey) {
    if (isCi()) throw new Error('Not authenticated. Run `fingerprint login` first.')
    // Ask whether they have an account (login vs signup), then run browser auth for both new and
    // returning users (signup + onboarding happen in the browser) and chain straight into integrate.
    await startAuth()
    return
  }

  // Authenticated (workspace already chosen in the browser) → integrate the repo in the current
  // directory (provisions keys + applies).
  await integrateCommand({ chained: true })
}

// A variadic optional positional lets the bare `fingerprint` run onboarding while still catching an
// unknown command (even a multi-word one) instead of erroring with "too many arguments".
program
  .argument('[command...]', 'command to run (omit to run the full onboarding)')
  .action((args: string[]) => defaultCommand(args[0]))

// Friendly unknown-command message with a "did you mean" suggestion, in place of commander's terse
// argument error. Known command names + aliases are the suggestion pool.
function reportUnknownCommand(name: string): void {
  const known = program.commands.flatMap((c) => [c.name(), ...c.aliases()])
  const suggestion = closestCommand(name, known)
  console.error(`Unknown command "${name}".`)
  if (suggestion) console.error(`Did you mean "${suggestion}"?`)
  console.error('\nRun `fingerprint --help` to see the available commands.')
  process.exitCode = 1
}

// Nearest known command by edit distance, but only when it's a plausible typo (not any random word).
function closestCommand(input: string, candidates: string[]): string | undefined {
  let best: string | undefined
  let bestDist = Infinity
  for (const c of candidates) {
    const d = editDistance(input, c)
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  return best !== undefined && bestDist <= Math.max(2, Math.ceil(input.length / 3)) ? best : undefined
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) dp[i][0] = i
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return dp[a.length][b.length]
}

program
  .parseAsync()
  .then(() => reportRun(process.exitCode ? 'error' : 'ok'))
  .catch(async (err) => {
    console.error(err.message)
    process.exitCode = 1
    await reportRun('error')
  })
