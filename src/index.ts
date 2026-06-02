#!/usr/bin/env node
import { Command } from 'commander'
import { signup, signupConfirm, login, logout, whoami } from './commands/auth.js'
import { workspaceList, workspaceStart, workspaceUse } from './commands/workspace.js'

const program = new Command()
program.name('fingerprint').description('Fingerprint CLI dashboard companion')

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
  .action(async (opts) => login({ apiUrl: opts.apiUrl, email: opts.email }))
program.command('logout').action(logout)
program.command('whoami').action(whoami)

const workspace = program.command('workspace')
workspace.command('ls').action(workspaceList)
workspace.command('start').action(workspaceStart)
workspace.command('use').argument('[id]').action(workspaceUse)

program.parseAsync().catch((err) => {
  console.error(err.message)
  process.exitCode = 1
})
