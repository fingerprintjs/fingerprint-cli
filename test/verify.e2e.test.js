import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  startManagementApi,
  startServerApi,
  startGateway,
  identificationEvent,
  makeHome,
  seedAuth,
  makeRepo,
  makeSkillsDir,
  runCli,
} from './helpers/harness.js'

// Post-integration verification: the run only ends after checking the integration can actually
// work — a reused secret key is probed, env-var names are checked, run instructions are printed,
// and (interactively) the first identification event is awaited. Non-interactive runs must not
// poll; `fingerprint verify` re-runs the check standalone.

let api
before(async () => {
  api = await startManagementApi()
})
after(async () => {
  await api.close()
})

// One full `integrate --yes` run against the fake gateway + Server API.
async function runIntegrate({ serverApi, repo, home }) {
  const skillsDir = makeSkillsDir()
  const gw = await startGateway(join(repo, 'web', 'fingerprint.js'), '// integration\n')
  const res = await runCli(['integrate', '--yes'], {
    home,
    cwd: repo,
    env: {
      FINGERPRINT_SKILLS_DIR: skillsDir,
      FINGERPRINT_GATEWAY_URL: gw.url,
      FINGERPRINT_SERVER_API_URL: serverApi.url,
    },
  })
  await gw.close()
  return res
}

test('a reused secret key from another workspace is reported', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  // A stale secret in the backend's .env — provisioning reuses it, verification must probe it.
  writeFileSync(join(repo, 'api', '.env'), 'FINGERPRINT_SECRET_API_KEY=srv_stale\n')
  const serverApi = await startServerApi({ badKeys: ['srv_stale'] })

  const res = await runIntegrate({ serverApi, repo, home })
  await serverApi.close()

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /not valid in region "us"/)
  // The probe used the reused key, not the login bundle's.
  assert.ok(serverApi.requests().some((r) => r.key === 'srv_stale'), JSON.stringify(serverApi.requests()))
})

test('a fresh login key skips the probe, and --yes does not poll', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const serverApi = await startServerApi()

  const res = await runIntegrate({ serverApi, repo, home })
  await serverApi.close()

  assert.equal(res.status, 0, res.stderr)
  // No reused key → no probe; non-interactive → no event polling. Zero Server API traffic.
  assert.equal(serverApi.requests().length, 0, JSON.stringify(serverApi.requests()))
  // The manual escape hatch is named instead.
  assert.match(res.stdout, /fingerprint verify/)
})

test('run instructions name the app’s own dev command', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  writeFileSync(
    join(repo, 'web', 'package.json'),
    JSON.stringify({ name: 'web', scripts: { dev: 'vite' }, dependencies: { react: '^18' } })
  )
  const serverApi = await startServerApi()

  const res = await runIntegrate({ serverApi, repo, home })
  await serverApi.close()

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /npm run dev/)
})

test('the run ends by naming the remaining get-started steps, installing nothing new', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const serverApi = await startServerApi()

  const res = await runIntegrate({ serverApi, repo, home })
  await serverApi.close()

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /request filtering/i)
  assert.match(res.stdout, /Smart Signals/)
  // Text only — no skills beyond the two the integration itself installed.
  const installed = readdirSync(join(repo, '.claude', 'skills')).sort()
  assert.deepEqual(installed, ['fingerprint-node', 'fingerprint-react'])
})

test('fingerprint verify confirms a received identification event', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const serverApi = await startServerApi({ events: [identificationEvent('v_verified')] })

  const res = await runCli(['verify'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SERVER_API_URL: serverApi.url },
  })
  await serverApi.close()

  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`)
  assert.match(res.stdout, /Identification received/)
  assert.match(res.stdout, /v_verified/)
})

test('fingerprint verify exits 1 when no event has arrived', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const serverApi = await startServerApi({ events: [] })

  const res = await runCli(['verify'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SERVER_API_URL: serverApi.url },
  })
  await serverApi.close()

  assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`)
  assert.match(res.stdout, /No identification event/)
})

test('fingerprint verify without a session points at login', async () => {
  const home = makeHome() // no seedAuth — logged out
  const repo = makeRepo()

  const res = await runCli(['verify'], { home, cwd: repo })

  assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`)
  assert.match(res.stdout, /fingerprint login/)
})
