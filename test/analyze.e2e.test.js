import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startManagementApi, startServerApi, startGateway, makeHome, seedAuth, makeRepo, makeSkillsDir, runCli } from './helpers/harness.js'

// `fingerprint analyze` against a fake Server API: the real command path reads the login bundle's
// Server API key, pages through /v4/events, and prints per-page counts and suggestions.
const login = (extra) => ({ event_id: 'e', timestamp: Date.now(), url: 'https://app.example.com/login', identification: { visitor_id: 'v', confidence: { score: 0.9 } }, ...extra })
const events = [
  ...Array.from({ length: 120 }, (_, i) => login({ identification: { visitor_id: `v${i % 7}`, confidence: { score: 0.9 } } })),
  ...Array.from({ length: 30 }, () => login({ bot: 'bad', vpn: true })),
  ...Array.from({ length: 10 }, () => ({ event_id: 'e', timestamp: Date.now(), url: 'https://app.example.com/pricing', identification: { visitor_id: 'p' } })),
]

// Keys for the "Apply a suggestion?" menu: Enter takes the first suggestion; the last entry stops.
const FIRST = '\n'
const DOWN = '\x1b[B'

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

  const res = await runCli(['analyze', '--path', repo], {
    home,
    env: { FINGERPRINT_SERVER_API_URL: serverApi.url },
    // Two suggestions, then "Not now".
    respond: [{ when: /Apply a suggestion/, send: `${DOWN}${DOWN}\n` }],
  })

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /160 on 2 pages/)
  assert.match(res.stdout, /\/login\s+150\s+30\s+20%/)
  assert.match(res.stdout, /does not read events from the Server API/)
  assert.match(res.stdout, /1\. Verify identification server-side/)
  assert.match(res.stdout, /2\. Block bad bots on \/login/)
  assert.match(res.stdout, /30 of 150 events \(20%\)/)
  assert.match(res.stdout, /Apply a suggestion with the agent\?/)
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

test('picking a suggestion runs the agent on exactly that step', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const skillsDir = makeSkillsDir()
  const target = join(repo, 'api', 'fingerprint-bots.js')
  const gw = await startGateway(target, '// reject bad bots\n')

  const res = await runCli(['analyze'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SERVER_API_URL: serverApi.url, FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gw.url },
    respond: [
      // [verify server-side, block bad bots, not now] → block bad bots.
      { when: /Apply a suggestion/, send: `${DOWN}\n` },
      // That one is done; the menu comes back without it: [verify server-side, done] → done.
      { when: /❯ (\x1b\[[0-9;]*m)*Verify identification server-side[\s\S]*Done for now/, send: `${DOWN}\n` },
    ],
  })
  const requests = gw.bodies().join('\n')
  await gw.close()

  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`)
  assert.match(res.stdout, /Blocking bad bots on \/login/)
  assert.match(requests, /Do only this step: block bad bots on the action behind the page \/login: 30 of 150/)
  assert.match(requests, /reject the request when its `bot` is/)
  assert.ok(existsSync(target), `agent did not write ${target}\n${res.stdout}`)
  assert.match(readFileSync(target, 'utf8'), /reject bad bots/)
  // The backend's .env was provisioned for the server-side check.
  assert.match(readFileSync(join(repo, 'api', '.env'), 'utf8'), /FINGERPRINT_SECRET_API_KEY=/)
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
  assert.ok(out.suggestions.every((s) => !('step' in s)))
})

test('--ci prints the report and never offers to apply', async () => {
  const home = makeHome()
  seedAuth(home, api.url)

  const res = await runCli(['analyze', '--ci', '--path', makeRepo()], { home, env: { FINGERPRINT_SERVER_API_URL: serverApi.url } })

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /Block bad bots on \/login/)
  assert.doesNotMatch(res.stdout, /Apply a suggestion/)
})

test('analyze without a login fails with the sign-in hint', async () => {
  const res = await runCli(['analyze'], { env: { FINGERPRINT_SERVER_API_URL: serverApi.url } })

  assert.notEqual(res.status, 0)
  assert.match(res.stderr, /fingerprint login/)
})
