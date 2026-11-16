import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startManagementApi, startServerApi, makeHome, seedAuth, makeRepo, runCli } from './helpers/harness.js'

// `fingerprint analyze` against a fake Server API: the real command path reads the login bundle's
// Server API key, pages through /v4/events, and prints per-page counts and suggestions.
const login = (extra) => ({ event_id: 'e', timestamp: Date.now(), url: 'https://app.example.com/login', identification: { visitor_id: 'v', confidence: { score: 0.9 } }, ...extra })
const events = [
  ...Array.from({ length: 120 }, (_, i) => login({ identification: { visitor_id: `v${i % 7}`, confidence: { score: 0.9 } } })),
  ...Array.from({ length: 30 }, () => login({ bot: 'bad', vpn: true })),
  ...Array.from({ length: 10 }, () => ({ event_id: 'e', timestamp: Date.now(), url: 'https://app.example.com/pricing', identification: { visitor_id: 'p' } })),
]

let api
let serverApi
before(async () => {
  api = await startManagementApi()
  serverApi = await startServerApi(events)
})
after(async () => {
  await api.close()
  await serverApi.close()
})

test('analyze pages through events, reports per page and suggests a bot rule', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()

  const res = await runCli(['analyze', '--path', repo], { home, env: { FINGERPRINT_SERVER_API_URL: serverApi.url } })

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /160 on 2 pages/)
  assert.match(res.stdout, /\/login\s+150\s+30\s+20%/)
  assert.match(res.stdout, /does not read events from the Server API/)
  assert.match(res.stdout, /1\. Verify identification server-side/)
  assert.match(res.stdout, /2\. Block bad bots on \/login/)
  assert.match(res.stdout, /30 of 150 events \(20%\)/)
  // Paged at the API's maximum with the Server API key, never the Management key.
  const reqs = serverApi.requests()
  assert.equal(reqs.length, 2)
  assert.equal(reqs[0].query.limit, '100')
  assert.ok(reqs[0].query.start)
  assert.equal(reqs[1].query.pagination_key, '100')
  assert.ok(reqs.every((r) => r.authorization === 'Bearer srv_1'))
  // Aggregates only: no visitor id reaches the terminal.
  assert.doesNotMatch(res.stdout, /v3/)
})

test('analyze --json emits the summary, and a verifying repo drops the first suggestion', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  writeFileSync(join(repo, 'api', 'verify.js'), "const { FingerprintServerApi } = require('@fingerprint/server-sdk')")

  const res = await runCli(['analyze', '--path', repo, '--json', '--max', '50'], { home, env: { FINGERPRINT_SERVER_API_URL: serverApi.url } })

  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.events, 50)
  assert.equal(out.repo.verifiesServerSide, true)
  assert.equal(out.pages[0].path, '/login')
  assert.ok(!out.suggestions.some((s) => s.title.startsWith('Verify')))
})

test('analyze without a login fails with the sign-in hint', async () => {
  const res = await runCli(['analyze'], { env: { FINGERPRINT_SERVER_API_URL: serverApi.url } })

  assert.notEqual(res.status, 0)
  assert.match(res.stderr, /fingerprint login/)
})
