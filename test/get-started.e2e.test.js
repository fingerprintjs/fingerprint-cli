import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startManagementApi, startGateway, makeHome, seedAuth, makeRepo, makeSkillsDir, runCli } from './helpers/harness.js'

// The integration is driven by the fingerprint-get-started orchestrator skill, not a hand-rolled
// prompt: the CLI installs the orchestrator alongside the detected framework skills, asks the agent
// to run the flow, and adds no guidance of its own afterwards — the skill covers how to verify.

let api
before(async () => {
  api = await startManagementApi()
})
after(async () => {
  await api.close()
})

test('integrate installs the orchestrator with the framework skills and lets it drive the run', async () => {
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
  // The agent is asked to run the orchestrator one step at a time; on the first run the CLI doesn't
  // pick the step. (Search every captured request — the SDK also makes internal calls, e.g. titling.)
  const requests = bodies.join('\n')
  assert.match(requests, /fingerprint-get-started/)
  assert.match(requests, /one step at a time/)
  assert.doesNotMatch(requests, /Quick start step 1|signup if present, else login/)
  // The CLI adds nothing after the agent: no verify section, no checklist, no "another project?".
  assert.doesNotMatch(res.stdout, /Verify it works|Get Started page|Next steps|another project/)
  // A scripted run (--yes) does exactly one step; it is never asked what's next.
  assert.doesNotMatch(res.stdout, /What's next/)
})

const APPLYING = /Applying .* via fingerprint-get-started/g
// Keys for the "What's next?" menu: Enter takes the first offered step; the last entry is "stop".
const FIRST = '\n'
const DOWN = '\x1b[B'
// The second menu, once it is on screen: the custom subdomain is its first entry, so it carries the
// pointer (with the highlight's colour codes in between). The question text itself is no marker —
// inquirer re-renders the answered first menu with "What's next?" too, and keys sent on that would
// land in whatever prompt comes before the second menu.
const SECOND_MENU = /❯ (\x1b\[[0-9;]*m)*Protect against ad blockers/

test('after a step the user picks the next one by name, and the agent is told to do exactly that step', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const skillsDir = makeSkillsDir()
  const gw = await startGateway(join(repo, 'web', 'fingerprint.js'), '// integration\n')

  const res = await runCli(['integrate'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gw.url },
    respond: [
      { when: /Integrate Fingerprint into this repo/, send: 'y\n' },
      // Step 1 landed; the first offer is server-side verification (the backend here has no SDK yet).
      { when: /What's next\?/, send: FIRST },
      // Server done → the menu is [custom subdomain, stop]; pick stop.
      { when: SECOND_MENU, send: `${DOWN}\n` },
    ],
  })
  const requests = gw.bodies().join('\n')
  await gw.close()

  assert.equal(res.status, 0, res.stderr)
  assert.equal(res.stdout.match(APPLYING)?.length, 2, res.stdout)
  // The user is told to test before choosing, and the choice reaches the agent as an explicit step.
  assert.match(res.stdout, /Test this step now/)
  assert.match(res.stdout, /Set up server-side verification/)
  assert.match(requests, /Do only this step: Quick start step 2/)
  assert.match(requests, /Do not announce or suggest what the next step is/)
  // Both halves live here, so there is no backend to ask for.
  assert.doesNotMatch(res.stdout, /Path to your backend repo/)
})

test('choosing server-side verification in a frontend-only repo asks where the backend is and runs the flow there', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const frontend = mkdtempSync(join(tmpdir(), 'fp-fe-'))
  writeFileSync(join(frontend, 'package.json'), JSON.stringify({ name: 'fe', dependencies: { react: '^18' } }))
  const backend = join(makeRepo(), 'api')
  const skillsDir = makeSkillsDir()
  const gw = await startGateway(join(frontend, 'fingerprint.js'), '// integration\n')

  const res = await runCli(['integrate'], {
    home,
    cwd: frontend,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gw.url },
    respond: [
      { when: /Integrate Fingerprint into this repo \(fingerprint-react\)/, send: 'y\n' },
      { when: /What's next\?/, send: FIRST }, // server-side verification
      { when: /Path to your backend repo/, send: `${backend}\n` },
      { when: /Integrate Fingerprint into this repo \(fingerprint-node\)/, send: 'y\n' },
      { when: SECOND_MENU, send: `${DOWN}\n` }, // [custom subdomain, stop] → stop
    ],
  })
  await gw.close()

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /Applying fingerprint-react via fingerprint-get-started/)
  assert.match(res.stdout, new RegExp(`Applying fingerprint-node via fingerprint-get-started in ${backend}`))
})
