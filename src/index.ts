#!/usr/bin/env node
import { Command } from 'commander'
import { select } from '@inquirer/prompts'
import { signup, signupConfirm, login, logout, whoami } from './commands/auth.js'
import { workspaceList, workspaceStart, workspaceUse } from './commands/workspace.js'
import { keysCommand } from './commands/keys.js'
import { integrateCommand } from './commands/integrate.js'
import { getAuthState, setSessionOverride } from './auth/tokenStore.js'
import { resolveConfig } from './config/config.js'
import { setCiContext, isCi } from './utils/ci.js'
import { setVerbose } from './utils/verbose.js'
import { setInteractive } from './utils/interactive.js'

const program = new Command()
program.name('fingerprint').description('Fingerprint CLI dashboard companion')

// Global flags shared by every command, used for headless/CI runs.
program
  .option('--ci', 'non-interactive: never prompt; auto-confirm and fail fast on missing input')
  .option('--api-key <token>', 'authenticate with a management API key instead of an interactive login')
  .option('--subscription <id>', 'workspace (subscription) id to use')
  .option('--api-url <url>')
  .option('-y, --yes', 'skip confirmation prompts')
  .option('--verbose', "show the agent's individual steps (file reads, edits, tool calls)")
  .option('--interactive', 'ask before each file edit and package install (default: apply automatically)')
  .option('--web', 'sign in through the browser instead of typing a password')

// Seed the CI/headless session from global flags before any command runs. With --api-key we
// build an in-memory auth state (never written to disk) so api/integrate work without a login.
program.hook('preAction', () => {
  const opts = program.opts<{ ci?: boolean; apiKey?: string; subscription?: string; apiUrl?: string; yes?: boolean; verbose?: boolean; interactive?: boolean }>()
  const ci = Boolean(opts.ci) || process.env.CI === 'true'
  setCiContext({ ci, yes: Boolean(opts.yes) || ci })
  setVerbose(Boolean(opts.verbose))
  // Per-step prompting needs a human; never enable it in CI/headless runs.
  setInteractive(Boolean(opts.interactive) && !ci)

  const apiKey = opts.apiKey ?? process.env.FINGERPRINT_API_KEY
  if (apiKey) {
    const cfg = resolveConfig(opts.apiUrl)
    setSessionOverride({
      accessToken: apiKey,
      currentSubscriptionId: opts.subscription ?? process.env.FINGERPRINT_SUBSCRIPTION_ID,
      apiUrl: cfg.apiUrl,
      region: cfg.region,
    })
  }
})

program
  .command('signup')
  .option('--api-url <url>')
  .option('--name <name>')
  .option('--email <email>')
  .action(async (opts) => signup({ apiUrl: opts.apiUrl, name: opts.name, email: opts.email }))
program.command('signup-confirm').argument('<linkOrIntent>').argument('[code]').action(signupConfirm)
program
  .command('login')
  .option('--api-url <url>')
  .option('--email <email>')
  .option('--web', 'sign in through the browser instead of typing a password')
  .action(async (opts) => login({ apiUrl: opts.apiUrl, email: opts.email, web: opts.web }))
program.command('logout').action(logout)
program.command('whoami').action(whoami)

const workspace = program.command('workspace')
workspace.command('ls').action(workspaceList)
workspace.command('start').action(workspaceStart)
workspace.command('use').argument('[id]').action(workspaceUse)

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
// onboarding is one command (signup → workspace → keys → integrate, resuming from any point).
async function defaultCommand() {
  const auth = getAuthState()

  // `fingerprint --web`: go straight to browser sign-in. login({web}) runs the loopback flow and
  // then continues the onboarding chain (workspace → keys → integrate) on its own.
  if (program.opts<{ web?: boolean }>().web) {
    if (isCi()) throw new Error('--web needs a browser; use --api-key for CI runs.')
    await login({ web: true })
    return
  }

  if (!auth?.accessToken) {
    if (isCi()) throw new Error('Not authenticated. Pass --api-key (and --subscription) for CI runs.')
    const choice = await select({
      message: 'Welcome to Fingerprint. What would you like to do?',
      choices: [
        { name: 'Continue in browser — sign up or log in', value: 'browser' },
        { name: 'Sign up with email/password', value: 'signup' },
        { name: 'Log in with email/password', value: 'login' },
      ],
    })
    if (choice === 'browser') await login({ web: true })
    else if (choice === 'signup') await signup()
    else await login()
    return
  }

  if (!auth.currentSubscriptionId) {
    if (isCi()) throw new Error('No active workspace. Pass --subscription <id> for CI runs.')
    await workspaceStart()
  }

  // Workspace is active → integrate the repo in the current directory (provisions keys + applies).
  await integrateCommand()
}

program.action(defaultCommand)

program.parseAsync().catch((err) => {
  console.error(err.message)
  process.exitCode = 1
})
