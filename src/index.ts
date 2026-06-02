#!/usr/bin/env node
import { Command } from 'commander'
import { signup, signupConfirm, login, logout, whoami } from './commands/auth.js'
import { workspaceList, workspaceStart, workspaceUse } from './commands/workspace.js'

const program = new Command()
program.name('fingerprint').description('Fingerprint CLI dashboard companion')

program.command('signup').option('--api-url <url>').action(async (opts) => signup(opts.apiUrl))
program.command('signup-confirm').argument('<linkOrIntent>').argument('[code]').action(signupConfirm)
program.command('login').option('--api-url <url>').action(async (opts) => login(opts.apiUrl))
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
