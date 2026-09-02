import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startManagementApi, startGateway, makeHome, seedAuth, makeRepo, makeSkillsDir, runCli } from './helpers/harness.js'

// A failed dependency install must fail the run: code changes without their packages mean the
// integration can never make an identification call, and the old behavior (warn, exit 0, report
// success) hid exactly that. These tests drive the real flow with a fake `pnpm` on PATH so no
// registry is touched and no lifecycle script runs.

let api
before(async () => {
  api = await startManagementApi()
})
after(async () => {
  await api.close()
})

// A fake pnpm ahead of the real one on PATH. `script` controls its output and exit code.
function makeFakePnpm(script) {
  const dir = mkdtempSync(join(tmpdir(), 'fp-bin-'))
  const file = join(dir, 'pnpm')
  writeFileSync(file, script)
  chmodSync(file, 0o755)
  return dir
}

const BLOCKED_BUILDS_PNPM = `#!/bin/sh
echo " ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: @fingerprint/js-agent." >&2
exit 1
`

// Repo whose frontend uses pnpm (lockfile drives detectPackageManager) and whose react skill
// declares a package, so the post-agent installer actually runs.
function setup() {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  writeFileSync(join(repo, 'web', 'pnpm-lock.yaml'), '')
  const skillsDir = makeSkillsDir({ 'fingerprint-react': ['@fingerprint/react'] })
  return { home, repo, skillsDir }
}

test('a blocked pnpm install fails the run and names the approve-builds remediation', async () => {
  const { home, repo, skillsDir } = setup()
  const fakeBin = makeFakePnpm(BLOCKED_BUILDS_PNPM)
  const gw = await startGateway(join(repo, 'web', 'fingerprint.js'), '// integration\n')

  const res = await runCli(['integrate', '--yes'], {
    home,
    cwd: repo,
    env: {
      FINGERPRINT_SKILLS_DIR: skillsDir,
      FINGERPRINT_GATEWAY_URL: gw.url,
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
  })
  await gw.close()

  assert.equal(res.status, 1, `expected exit 1\n${res.stdout}\n${res.stderr}`)
  // The run must not claim success when the packages the code needs are missing.
  assert.ok(!res.stdout.includes('Agent finished applying the integration'), res.stdout)
  assert.match(res.stdout, /code changes were applied/i)
  // pnpm's blocked-build-scripts failure gets its specific remediation, not the generic message.
  assert.match(res.stdout, /pnpm approve-builds/)
})

test('declining an interactive install is not a failure', async () => {
  const { home, repo, skillsDir } = setup()
  // If the install runs despite being declined, the fake pnpm turns it into a loud failure.
  const fakeBin = makeFakePnpm('#!/bin/sh\necho "should not have run" >&2\nexit 1\n')
  const gw = await startGateway(join(repo, 'web', 'fingerprint.js'), '// integration\n')

  const res = await runCli(['integrate', '--yes', '--interactive'], {
    home,
    cwd: repo,
    env: {
      FINGERPRINT_SKILLS_DIR: skillsDir,
      FINGERPRINT_GATEWAY_URL: gw.url,
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
    respond: [
      { when: /create\/overwrite/, send: 'y\n' }, // allow the agent's Write
      { when: /Install @fingerprint\/react/, send: 'n\n' }, // decline the package install
    ],
  })
  await gw.close()

  assert.equal(res.status, 0, `expected exit 0\n${res.stdout}\n${res.stderr}`)
  assert.match(res.stdout, /Skipped — install manually/)
  assert.ok(!res.stdout.includes('should not have run'), 'declined install still executed pnpm')
})
