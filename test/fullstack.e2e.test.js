import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startManagementApi, startGateway, makeHome, seedAuth, makeSkillsDir, runCli } from './helpers/harness.js'

// One package.json can hold both halves of the stack — two dependencies (react + express), or a
// framework that is its own server (Next.js). The backend is then the same app as the frontend, not
// a missing one: it must get the server skill, the secret key, and no "where is your backend?"
// prompt.

let api
before(async () => {
  api = await startManagementApi()
})
after(async () => {
  await api.close()
})

function singleManifestRepo(dependencies) {
  const root = mkdtempSync(join(tmpdir(), 'fp-single-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies }))
  return root
}

// Keys for the "What's next?" menu (see get-started.e2e.test.js).
const FIRST = '\n'
const DOWN = '\x1b[B'
const SECOND_MENU = /❯ (\x1b\[[0-9;]*m)*Protect against ad blockers/

test('a single manifest with both halves resolves both skills and provisions both keys', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = singleManifestRepo({ react: '^18', express: '^4' })
  const skillsDir = makeSkillsDir()
  const gw = await startGateway(join(repo, 'fingerprint.js'), '// integration\n')

  const res = await runCli(['integrate', '--yes'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gw.url },
  })
  const requests = gw.bodies().join('\n')
  await gw.close()

  assert.equal(res.status, 0, res.stderr)
  // The express half is only reachable via backendFramework — `framework` reports the frontend one.
  assert.match(res.stdout, /Skills\s+fingerprint-react \+ fingerprint-node/)
  const installed = readdirSync(join(repo, '.claude', 'skills')).sort()
  assert.deepEqual(installed, ['fingerprint-get-started', 'fingerprint-node', 'fingerprint-react'])

  // Both halves, one env file: the client key and the secret the server verifies with.
  const env = readFileSync(join(repo, '.env'), 'utf8')
  for (const key of ['VITE_FINGERPRINT_PUBLIC_API_KEY=pub_123', 'VITE_FINGERPRINT_REGION=us', 'FINGERPRINT_SECRET_API_KEY=srv_1', 'FINGERPRINT_REGION=us']) {
    assert.ok(env.includes(key), `missing ${key} in:\n${env}`)
  }

  // Described as one app, not as a frontend and a backend that happen to share a path.
  assert.match(requests, /one app at \.\/\. serving both halves \(react \+ express\)/)
})

test('server-side verification in a single-manifest repo runs in place, without asking for a backend path', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = singleManifestRepo({ react: '^18', express: '^4' })
  const skillsDir = makeSkillsDir()
  const gw = await startGateway(join(repo, 'fingerprint.js'), '// integration\n')

  const res = await runCli(['integrate'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gw.url },
    respond: [
      { when: /Integrate Fingerprint into this repo \(fingerprint-react \+ fingerprint-node\)/, send: 'y\n' },
      { when: /What's next\?/, send: FIRST }, // server-side verification
      { when: SECOND_MENU, send: `${DOWN}\n` }, // [custom subdomain, stop] → stop
    ],
  })
  const requests = gw.bodies().join('\n')
  await gw.close()

  assert.equal(res.status, 0, res.stderr)
  assert.doesNotMatch(res.stdout, /Path to your backend repo/)
  assert.match(requests, /Do only this step: Quick start step 2/)
})

test('a Next.js app is its own backend, so the server step never asks where the backend is', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = singleManifestRepo({ next: '^14', react: '^18' })
  const skillsDir = makeSkillsDir()
  const gw = await startGateway(join(repo, 'fingerprint.js'), '// integration\n')

  const res = await runCli(['integrate'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gw.url },
    respond: [
      { when: /Integrate Fingerprint into this repo \(fingerprint-nextjs\)/, send: 'y\n' },
      { when: /What's next\?/, send: FIRST }, // server-side verification
      { when: SECOND_MENU, send: `${DOWN}\n` },
    ],
  })
  await gw.close()

  assert.equal(res.status, 0, res.stderr)
  // One skill still covers both halves — the backend pointer must not pull in a second one.
  assert.match(res.stdout, /Skills\s+fingerprint-nextjs$/m)
  assert.doesNotMatch(res.stdout, /Path to your backend repo/)
})
