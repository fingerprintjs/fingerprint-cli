import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startManagementApi, startGateway, makeHome, seedAuth, makeRepo, makeSkillsDir, runCli } from './helpers/harness.js'

// The full `integrate` flow as a user runs it: provision real keys into per-app .env from the
// (fake) public Management API, then run the agent against a (fake) LLM gateway that drives one
// Write. Exercises the genuine path end to end — provision -> install skills -> run agent -> apply
// edit — with no network, no credentials, and no real LLM call.
let api
before(async () => {
  api = await startManagementApi()
})
after(async () => {
  await api.close()
})

test('integrate --yes provisions keys and the agent applies the integration edit', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const skillsDir = makeSkillsDir()
  const target = join(repo, 'web', 'fingerprint.js')
  const gw = await startGateway(target, '// fingerprint integration applied\n')

  const res = await runCli(['integrate', '--yes'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gw.url },
  })
  await gw.close()

  assert.equal(res.status, 0, res.stderr)

  // Provisioning half: public key + region landed in the frontend .env.
  const webEnv = readFileSync(join(repo, 'web', '.env'), 'utf8')
  assert.match(webEnv, /VITE_FINGERPRINT_PUBLIC_API_KEY=pub_123/)
  assert.match(webEnv, /VITE_FINGERPRINT_REGION=us/)

  // Agent half: the gateway-scripted Write actually hit the filesystem.
  assert.ok(existsSync(target), `agent did not write ${target}\n${res.stdout}\n${res.stderr}`)
  assert.match(readFileSync(target, 'utf8'), /fingerprint integration applied/)
  assert.ok(gw.calls() >= 1, 'gateway was never called')
})
