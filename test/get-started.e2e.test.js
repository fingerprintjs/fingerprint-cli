import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  startManagementApi,
  startServerApi,
  startGateway,
  makeHome,
  seedAuth,
  makeRepo,
  makeSkillsDir,
  runCli,
} from './helpers/harness.js'

// The integration is driven by the fingerprint-get-started orchestrator skill, not a hand-rolled
// prompt: the CLI installs the orchestrator plus everything it can dispatch to, the agent is asked
// to run the quick-start scope, and the later checklist steps only run after the first
// identification event is confirmed — which never happens in a non-interactive run.

let api
before(async () => {
  api = await startManagementApi()
})
after(async () => {
  await api.close()
})

async function runIntegrate({ repo, home }) {
  const skillsDir = makeSkillsDir()
  const serverApi = await startServerApi()
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
  const bodies = gw.bodies()
  await gw.close()
  await serverApi.close()
  return { res, bodies }
}

test('integrate installs the get-started dispatch set, minus proxy-integration', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()

  const { res, bodies } = await runIntegrate({ repo, home })

  assert.equal(res.status, 0, res.stderr)
  const installed = readdirSync(join(repo, '.claude', 'skills')).sort()
  assert.deepEqual(installed, [
    'fingerprint-get-started',
    'fingerprint-node',
    'fingerprint-react',
    'fingerprint-request-filtering',
    'fingerprint-rules-engine',
    'fingerprint-smart-signals',
    'fingerprint-tagging',
  ])
  // The agent is asked to run the orchestrator with quick-start scope, not the old fixed target.
  // (Search every captured request — the SDK also makes internal calls, e.g. session titling.)
  const requests = bodies.join('\n')
  assert.match(requests, /fingerprint-get-started/)
  assert.match(requests, /Quick start/)
  assert.doesNotMatch(requests, /signup if present, else login/)
})

test('without a confirmed event the run does not advance past quick start', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()

  const { res } = await runIntegrate({ repo, home })

  assert.equal(res.status, 0, res.stderr)
  // Non-interactive → no event poll → no confirmation → the continuation must not start; the run
  // points at manual verification and prints the remaining checklist instead.
  assert.match(res.stdout, /fingerprint verify/)
  assert.ok(!res.stdout.includes('Finish the Quick start'), res.stdout)
  assert.match(res.stdout, /request filtering/i)
})
