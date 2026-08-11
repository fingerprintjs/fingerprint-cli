import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  makeHome,
  makeRepo,
  makeSkillsDir,
  runCli,
  seedAuth,
  startGateway,
  startManagementApi,
} from './helpers/harness.js'

// Drives a real integration so the chained cases below reach `integrate` for real.
async function runInRepo(api, args) {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const skillsDir = makeSkillsDir()
  const gw = await startGateway(join(repo, 'web', 'fingerprint.js'), '// applied\n')

  const res = await runCli(args, {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gw.url },
  })
  await gw.close()
  return res
}

const names = (api) => api.analyticsEvents().map((e) => e.body.event)
const commands = (api) =>
  api
    .analyticsEvents()
    .filter((e) => e.body.event === 'cli_command_run')
    .map((e) => e.body.properties.command)

// `whoami` is the subject throughout: it's the cheapest command that needs no network of its own,
// so anything the fake Management API sees came from the telemetry hook.

test('an authenticated command reports which command ran', async () => {
  const api = await startManagementApi()
  const home = makeHome()
  seedAuth(home, api.url)

  const res = await runCli(['whoami'], { home })
  assert.equal(res.status, 0, res.stderr)

  const events = api.analyticsEvents()
  assert.equal(events.length, 1)
  assert.equal(events[0].body.event, 'cli_command_run')
  const { run_id, ...properties } = events[0].body.properties
  assert.deepEqual(properties, { command: 'whoami', cli_flags: '' })
  assert.match(run_id, /^[0-9a-f-]{36}$/)
  assert.equal(events[0].authorization, 'Bearer mgmt_key_1')

  await api.close()
})

test('a chained run reports the step the command hook cannot see', async () => {
  const api = await startManagementApi()

  // The bare `fingerprint` runs integrate from inside its own action, so commander never dispatches
  // it and the hook only ever sees `default`.
  const res = await runInRepo(api, ['--yes'])
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(names(api), ['cli_integrate_started', 'cli_command_run'])
  assert.deepEqual(commands(api), ['default'])

  // Both halves of the run are attributable to one invocation.
  const runIds = new Set(api.analyticsEvents().map((e) => e.body.properties.run_id))
  assert.equal(runIds.size, 1)

  await api.close()
})

test('an invoked integrate is reported as invoked, not chained', async () => {
  const api = await startManagementApi()

  const res = await runInRepo(api, ['integrate', '--yes'])
  assert.equal(res.status, 0, res.stderr)
  const [started, run] = api.analyticsEvents()
  assert.equal(started.body.event, 'cli_integrate_started')
  assert.equal(started.body.properties.chained, false)
  assert.equal(run.body.properties.command, 'integrate')
  assert.equal(run.body.properties.cli_flags, 'yes')

  await api.close()
})

test('logout reports with the credential it just dropped', async () => {
  const api = await startManagementApi()
  const home = makeHome()
  seedAuth(home, api.url)

  const res = await runCli(['logout'], { home })
  assert.equal(res.status, 0, res.stderr)

  // Auth state is already gone by the time the hook reports, so this can only have come from the
  // snapshot pinned before it was cleared.
  const events = api.analyticsEvents()
  assert.deepEqual(commands(api), ['logout'])
  assert.equal(events[0].authorization, 'Bearer mgmt_key_1')

  // And it still actually logged out: a follow-up run has no credential to report with.
  const after = await runCli(['whoami'], { home })
  assert.equal(after.status, 1)
  assert.equal(api.analyticsEvents().length, 1)

  await api.close()
})

test('a mistyped command is not reported as a bare run', async () => {
  const api = await startManagementApi()
  const home = makeHome()
  seedAuth(home, api.url)

  const res = await runCli(['integrat'], { home })
  assert.equal(res.status, 1, res.stdout)
  assert.deepEqual(commands(api), ['unknown'])

  await api.close()
})

test('an unauthenticated run sends nothing', async () => {
  const api = await startManagementApi()

  // Fresh home, so no auth state. The API URL still points at the fake server: if the gate ever
  // regressed, the request would land here rather than silently going to production.
  const res = await runCli(['logout'], { home: makeHome(), env: { FINGERPRINT_MANAGEMENT_API_URL: api.url } })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(api.analyticsEvents(), [])

  await api.close()
})
