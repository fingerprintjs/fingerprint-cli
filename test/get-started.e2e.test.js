import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { startManagementApi, startGateway, makeHome, seedAuth, makeRepo, makeSkillsDir, runCli } from './helpers/harness.js'

// The integration is driven by the fingerprint-get-started orchestrator skill, not a hand-rolled
// prompt: the CLI installs the orchestrator alongside the detected framework skills, and the agent
// is asked to run the quick-start scope only — the later checklist steps are reported, not applied.

let api
before(async () => {
  api = await startManagementApi()
})
after(async () => {
  await api.close()
})

test('integrate installs the orchestrator with the framework skills and scopes the run to quick start', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const skillsDir = makeSkillsDir()
  const gw = await startGateway(join(repo, 'web', 'fingerprint.js'), '// integration\n')

  const res = await runCli(['integrate', '--yes'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gw.url },
  })
  const bodies = gw.bodies()
  await gw.close()

  assert.equal(res.status, 0, res.stderr)
  const installed = readdirSync(join(repo, '.claude', 'skills')).sort()
  assert.deepEqual(installed, ['fingerprint-get-started', 'fingerprint-node', 'fingerprint-react'])
  // The agent is asked to run the orchestrator with quick-start scope, not the old fixed target.
  // (Search every captured request — the SDK also makes internal calls, e.g. session titling.)
  const requests = bodies.join('\n')
  assert.match(requests, /fingerprint-get-started/)
  assert.match(requests, /Quick start/)
  assert.doesNotMatch(requests, /signup if present, else login/)
})
