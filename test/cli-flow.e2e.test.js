import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startMgmtApi, makeHome, seedAuth, makeRepo, runCli } from './helpers/harness.js'

// Drives the REAL post-login commands a user runs, as subprocesses against a fake mgmt-api over
// HTTP. Auth is seeded (the login password prompt needs a PTY, which we avoid to stay dependency
// free); everything else is the genuine command path: workspace listing, key provisioning, repo
// analysis — each making the same API calls the real CLI makes.
let api
before(async () => {
  api = await startMgmtApi()
})
after(async () => {
  await api.close()
})

test('workspace ls lists the workspaces from the API', async () => {
  const home = makeHome()
  seedAuth(home, api.url)

  const res = await runCli(['workspace', 'ls'], { home })

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /sub_1/)
  assert.match(res.stdout, /Test WS/)
})

test('keys public fetches the browser key for the active workspace', async () => {
  const home = makeHome()
  seedAuth(home, api.url, { currentSubscriptionId: 'sub_1' })

  const res = await runCli(['keys', 'public'], { home })

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /pub_123/)
})

test('keys secret creates and prints a secret key', async () => {
  const home = makeHome()
  seedAuth(home, api.url, { currentSubscriptionId: 'sub_1' })

  const res = await runCli(['keys', 'secret'], { home })

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /sec_456/)
})

test('integrate --analyze reports the detected stack (read-only, no apply)', async () => {
  const home = makeHome()
  seedAuth(home, api.url, { currentSubscriptionId: 'sub_1' })
  const repo = makeRepo()

  const res = await runCli(['integrate', '--analyze'], { home, cwd: repo })

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /react/)
  assert.match(res.stdout, /express/)
  // React + Express → the two curated skills should be matched.
  assert.match(res.stdout, /fingerprint-react/)
  assert.match(res.stdout, /fingerprint-node/)
})
