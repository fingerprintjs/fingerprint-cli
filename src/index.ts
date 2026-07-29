#!/usr/bin/env node
import { Command } from 'commander'
import { login, signup, startAuth, logout, whoami } from './commands/auth.js'
import { keysCommand } from './commands/keys.js'
import { integrateCommand } from './commands/integrate.js'
import { getAuthState } from './auth/tokenStore.js'
import { setCiContext, isCi } from './utils/ci.js'
import { setVerbose } from './utils/verbose.js'
import { setInteractive } from './utils/interactive.js'
import { trackCommand } from './analytics/track.js'

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

// postAction, not preAction, so `login` has written credentials by the time we look for a workspace.
program.hook('postAction', async (_thisCommand, actionCommand) => {
  await trackCommand(actionCommand === program ? 'default' : actionCommand.name())
})

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
  .description('Generate an API key for the active workspace and print it')
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
    reportUnknownCommand(unknownCommand)
    return
  }

  const auth = getAuthState()

  if (!auth?.managementApiKey) {
    if (isCi()) throw new Error('Not authenticated. Run `fingerprint login` first.')
    // Ask whether they have an account (login vs signup), then run browser auth for both new and
    // returning users (signup + onboarding happen in the browser) and chain straight into integrate.
    await startAuth()
    return
  }

  // Authenticated (workspace already chosen in the browser) → integrate the repo in the current
  // directory (provisions keys + applies).
  await integrateCommand()
}

// Named alias for the default flow, so it can be invoked explicitly — e.g.
// `npx fingerprintjs/fingerprint-cli#<branch> setup`.
program
  .command('setup')
  .description('Run the full Fingerprint onboarding: login → integrate')
  .action(() => defaultCommand())

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

program.parseAsync().catch((err) => {
  console.error(err.message)
  process.exitCode = 1
})
