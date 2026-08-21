import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  startManagementApi,
  startGateway,
  makeHome,
  seedAuth,
  makeRepo,
  makeSkillsDir,
  makeFrontendOnlyPnpmRepo,
  makePnpmIgnoredBuildsBin,
  runCli,
} from './helpers/harness.js'

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

test('frontend-only pnpm integration fails closed when package installation is blocked', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeFrontendOnlyPnpmRepo()
  const skillsDir = makeSkillsDir({ reactPackages: ['@fingerprint/react'] })
  const pnpmBin = makePnpmIgnoredBuildsBin()
  const target = join(repo, 'src', 'fingerprint.ts')
  const wranglerBefore = readFileSync(join(repo, 'wrangler.jsonc'), 'utf8')
  const gw = await startGateway(target, '// frontend identification applied\n')

  const res = await runCli(['integrate', '--yes'], {
    home,
    cwd: repo,
    env: {
      FINGERPRINT_SKILLS_DIR: skillsDir,
      FINGERPRINT_GATEWAY_URL: gw.url,
      PATH: `${pnpmBin}:${process.env.PATH}`,
    },
  })
  await gw.close()

  assert.equal(res.status, 1, `install failure was treated as success\n${res.stdout}\n${res.stderr}`)
  assert.match(res.stdout, /Install failed/)
  assert.match(res.stdout, /pnpm approve-builds/)
  assert.doesNotMatch(res.stdout, /integration completed/i)

  const agentRequest = gw.requests().join('\n')
  assert.match(agentRequest, /Do not create a backend, server, serverless function, or worker/i)
  assert.doesNotMatch(agentRequest, /send the event_id, and verify it server-side/i)

  assert.equal(readFileSync(join(repo, 'wrangler.jsonc'), 'utf8'), wranglerBefore)
  assert.equal(existsSync(join(repo, 'wrangler.toml')), false)
  assert.equal(existsSync(join(repo, 'src', 'worker.ts')), false)
})

test('frontend-only integration blocks an agent from creating a Worker backend', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeFrontendOnlyPnpmRepo()
  const skillsDir = makeSkillsDir()
  const worker = join(repo, 'src', 'worker.ts')
  const wranglerBefore = readFileSync(join(repo, 'wrangler.jsonc'), 'utf8')
  const gw = await startGateway(worker, '// backend the frontend skill must not create\n')

  const res = await runCli(['integrate', '--yes'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gw.url },
  })
  await gw.close()

  assert.equal(res.status, 1, `out-of-scope edit was treated as success\n${res.stdout}\n${res.stderr}`)
  assert.equal(existsSync(worker), false, 'frontend-only integration created a Worker backend')
  assert.equal(readFileSync(join(repo, 'wrangler.jsonc'), 'utf8'), wranglerBefore)
  assert.match(res.stdout, /attempted to create backend or deployment files/i)
  assert.doesNotMatch(res.stdout, /integration completed/i)
})
