import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VERSION } from '../dist/version.js'

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
// Every run now opens with `cli_run_started`, so the events a test is actually about are found by
// name rather than by position.
const first = (api, name) => api.analyticsEvents().find((e) => e.body.event === name)
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

  assert.deepEqual(names(api), ['cli_run_started', 'cli_command_run'])
  const run = first(api, 'cli_command_run')
  const { run_id, ...properties } = run.body.properties
  assert.deepEqual(properties, { command: 'whoami', cli_flags: '', status: 'ok' })
  assert.match(run_id, /^[0-9a-f-]{36}$/)
  assert.equal(run.authorization, 'Bearer mgmt_key_1')
  assert.equal(run.userAgent, `fingerprint-cli/${VERSION}`)
  // A signed-in run has a key from the first event onward, so nothing takes the anonymous route.
  assert.deepEqual(new Set(api.analyticsEvents().map((e) => e.path)), new Set(['/analytics/events']))

  await api.close()
})

test('a chained run reports the step the command hook cannot see', async () => {
  const api = await startManagementApi()

  // The bare `fingerprint` runs integrate from inside its own action, so commander never dispatches
  // it and the hook only ever sees `default`.
  const res = await runInRepo(api, ['--yes'])
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(names(api), ['cli_run_started', 'cli_integrate_started', 'cli_command_run'])
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
  const started = first(api, 'cli_integrate_started')
  assert.equal(started.body.properties.chained, false)
  const run = first(api, 'cli_command_run')
  assert.equal(run.body.properties.command, 'integrate')
  assert.equal(run.body.properties.cli_flags, 'yes')

  await api.close()
})

test('an integrate that applies nothing reports why', async () => {
  const api = await startManagementApi()
  const home = makeHome()
  seedAuth(home, api.url)

  const empty = mkdtempSync(join(tmpdir(), 'fp-empty-'))
  const res = await runCli(['integrate'], { home, cwd: empty })
  assert.equal(res.status, 0, res.stderr)

  const skipped = first(api, 'cli_integrate_skipped')
  assert.equal(skipped.body.properties.reason, 'no_apps_found')
  assert.equal(skipped.body.properties.app_count, 0)

  await api.close()
})

test('a repo we found apps in but recognised no framework is reported as such', async () => {
  const api = await startManagementApi()
  const home = makeHome()
  seedAuth(home, api.url)

  const repo = mkdtempSync(join(tmpdir(), 'fp-unknown-'))
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'x', dependencies: { lodash: '^4' } }))

  const res = await runCli(['integrate'], { home, cwd: repo })
  assert.equal(res.status, 0, res.stderr)

  const skipped = first(api, 'cli_integrate_skipped')
  assert.equal(skipped.body.properties.reason, 'no_supported_framework')
  assert.equal(skipped.body.properties.app_count, 1)

  await api.close()
})

test('an analyze-only run is not counted as a dead end', async () => {
  const api = await startManagementApi()
  const home = makeHome()
  seedAuth(home, api.url)

  const res = await runCli(['integrate', '--analyze'], { home, cwd: makeRepo() })
  assert.equal(res.status, 0, res.stderr)

  const skipped = first(api, 'cli_integrate_skipped')
  assert.equal(skipped.body.properties.reason, 'analyze_only')
  assert.equal(skipped.body.properties.frontend, 'react')

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
  assert.deepEqual(commands(api), ['logout'])
  assert.equal(first(api, 'cli_command_run').authorization, 'Bearer mgmt_key_1')

  // And it still actually logged out: a follow-up run has no credential, so it reports through the
  // anonymous route and `cli_command_run` never fires, because `whoami` exits before it settles.
  const after = await runCli(['whoami'], { home, env: { FINGERPRINT_MANAGEMENT_API_URL: api.url } })
  assert.equal(after.status, 1)
  const anonymous = api.analyticsEvents().filter((e) => e.path === '/analytics/anonymous-events')
  assert.deepEqual(
    anonymous.map((e) => e.body.event),
    ['cli_run_started', 'cli_command_run']
  )
  assert.equal(anonymous[0].authorization, undefined)
  // No key to identify the caller on this route, so the Management API gates on these two instead.
  assert.equal(anonymous[0].client, 'cli')
  assert.match(anonymous[0].userAgent, /^fingerprint-cli\/\d+\.\d+\.\d+/)

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

test('a command that fails still reports, with status error', async () => {
  // Serves analytics and fails everything else, so `keys` throws after auth exists. This is what
  // used to report nothing at all: a throw skips commander's postAction hook.
  const events = []
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url.startsWith('/analytics/events')) {
        events.push(JSON.parse(body))
        res.writeHead(202).end()
        return
      }
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"boom"}}')
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))

  const home = makeHome()
  seedAuth(home, `http://127.0.0.1:${srv.address().port}`)
  const res = await runCli(['keys', 'public'], { home })
  assert.equal(res.status, 1)
  assert.deepEqual(
    events.filter((e) => e.event === 'cli_command_run').map((e) => `${e.properties.command}:${e.properties.status}`),
    ['keys:error']
  )

  srv.close()
})

test('an unauthenticated run reports through the anonymous route, with no key attached', async () => {
  const api = await startManagementApi()

  // Fresh home, so no auth state anywhere in the run.
  const res = await runCli(['logout'], { home: makeHome(), env: { FINGERPRINT_MANAGEMENT_API_URL: api.url } })
  assert.equal(res.status, 0, res.stderr)

  const events = api.analyticsEvents()
  assert.deepEqual(names(api), ['cli_run_started', 'cli_command_run'])
  assert.deepEqual(new Set(events.map((e) => e.path)), new Set(['/analytics/anonymous-events']))
  // Absent rather than empty: `Bearer ` reads as a malformed token, not as an unauthenticated caller.
  assert.ok(events.every((e) => e.authorization === undefined))
  // Still one run, so these join the run's later events if it goes on to sign in.
  assert.equal(new Set(events.map((e) => e.body.properties.run_id)).size, 1)

  await api.close()
})

test('an unauthenticated run withholds the events that need a workspace', async () => {
  const api = await startManagementApi()

  // `integrate` provisions keys, so it fails without auth. The Management API would reject
  // `cli_integrate_skipped` on the anonymous route anyway; this keeps the guaranteed 400 off the wire.
  const empty = mkdtempSync(join(tmpdir(), 'fp-anon-'))
  await runCli(['integrate'], { home: makeHome(), cwd: empty, env: { FINGERPRINT_MANAGEMENT_API_URL: api.url } })

  assert.ok(!names(api).includes('cli_integrate_skipped'))
  assert.ok(!names(api).includes('cli_integrate_started'))

  await api.close()
})
