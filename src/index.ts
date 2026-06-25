#!/usr/bin/env node
import { Command } from 'commander'
import { select } from '@inquirer/prompts'
import { signup, signupConfirm, login, logout, whoami, resumeEmailConfirmation } from './commands/auth.js'
import { workspaceList, workspaceStart, workspaceUse } from './commands/workspace.js'
import { keysCommand } from './commands/keys.js'
import { integrateCommand } from './commands/integrate.js'
import { getAuthState } from './auth/tokenStore.js'
import { setCiContext, isCi } from './utils/ci.js'
import { setVerbose } from './utils/verbose.js'
import { setInteractive } from './utils/interactive.js'

const program = new Command()
program.name('fingerprint').description('Fingerprint CLI dashboard companion')

// Global flags shared by every command, used for headless/CI runs.
program
  .option('--ci', 'non-interactive: never prompt; auto-confirm and fail fast on missing input')
  .option('--api-url <url>')
  .option('-y, --yes', 'skip confirmation prompts')
  .option('--verbose', "show the agent's individual steps (file reads, edits, tool calls)")
  .option('--interactive', 'ask before each file edit and package install (default: apply automatically)')

// Seed the CI/headless session from global flags before any command runs.
program.hook('preAction', () => {
  const opts = program.opts<{ ci?: boolean; apiUrl?: string; yes?: boolean; verbose?: boolean; interactive?: boolean }>()
  const ci = Boolean(opts.ci) || process.env.CI === 'true'
  setCiContext({ ci, yes: Boolean(opts.yes) || ci })
  setVerbose(Boolean(opts.verbose))
  // Per-step prompting needs a human; never enable it in CI/headless runs.
  setInteractive(Boolean(opts.interactive) && !ci)
})

program
  .command('signup')
  .option('--api-url <url>')
  .option('--name <name>')
  .option('--email <email>')
  .action(async (opts) => {
    const globalOpts = program.opts<{ apiUrl?: string }>()
    return signup({ apiUrl: opts.apiUrl ?? globalOpts.apiUrl, name: opts.name, email: opts.email })
  })
program.command('signup-confirm').argument('<linkOrIntent>').argument('[code]').action(signupConfirm)
program
  .command('login')
  .option('--api-url <url>')
  .option('--email <email>')
  .action(async (opts) => {
    const globalOpts = program.opts<{ apiUrl?: string }>()
    return login({ apiUrl: opts.apiUrl ?? globalOpts.apiUrl, email: opts.email })
  })
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

  if (!auth?.accessToken) {
    if (isCi()) throw new Error('Not authenticated. Run `fingerprint login` first.')
    const choice = await select({
      message: 'Welcome to Fingerprint. What would you like to do?',
      choices: [
        { name: 'Sign up with email/password', value: 'signup' },
        { name: 'Log in with email/password', value: 'login' },
      ],
    })
    if (choice === 'signup') await signup()
    else await login()
    return
  }

  // Email confirmation must complete before workspace/keys — the mgmt-api rejects those calls for an
  // unconfirmed account ("no permission"). Resume at confirmation rather than skipping ahead.
  if (auth.pendingEmailConfirmation) {
    if (isCi()) throw new Error('Email not confirmed. Confirm with `fingerprint signup-confirm "<link from email>"` first.')
    console.log("Your email isn't confirmed yet — finish that before setting up a workspace.")
    await resumeEmailConfirmation()
    return
  }

  if (!auth.currentSubscriptionId) {
    if (isCi()) throw new Error('No active workspace. Run `fingerprint workspace use <id>` first.')
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
