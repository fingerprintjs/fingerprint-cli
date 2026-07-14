import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startManagementApi, makeHome, seedAuth, makeRepo, runCli } from './helpers/harness.js'

// Drives the REAL post-login commands a user runs, as subprocesses against a fake public Management
// API over HTTP. Auth is seeded (the browser login flow needs a real browser, which we avoid to stay
// dependency free); everything else is the genuine command path: key provisioning and repo analysis,
// each making the same Management API calls the real CLI makes with its workspace-scoped key.
let api
before(async () => {
  api = await startManagementApi()
})
after(async () => {
  await api.close()
})

test('keys public fetches the browser key for the workspace', async () => {
  const home = makeHome()
  seedAuth(home, api.url)

  const res = await runCli(['keys', 'public'], { home })

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /pub_123/)
})

test('keys secret creates and prints a secret key', async () => {
  const home = makeHome()
  seedAuth(home, api.url)

  const res = await runCli(['keys', 'secret'], { home })

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /sec_456/)
})

test('integrate --analyze reports the detected stack (read-only, no apply)', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()

  const res = await runCli(['integrate', '--analyze'], { home, cwd: repo })

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /react/)
  assert.match(res.stdout, /express/)
  // React + Express → the two curated skills should be matched.
  assert.match(res.stdout, /fingerprint-react/)
  assert.match(res.stdout, /fingerprint-node/)
})
