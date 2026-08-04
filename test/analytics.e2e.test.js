import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeHome, runCli, seedAuth, startManagementApi } from './helpers/harness.js'

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
  assert.deepEqual(events[0].body, { event: 'cli_command_run', properties: { command: 'whoami' } })
  assert.equal(events[0].authorization, 'Bearer mgmt_key_1')

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
