import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startManagementApi, startGateway, makeHome, seedAuth, makeRepo, makeSkillsDir, runCli } from './helpers/harness.js'

// A failed dependency install must fail the run: code changes without their packages mean the
// integration can never make an identification call, and the old behavior (warn, exit 0, report
// success) hid exactly that. pnpm's blocked install scripts are the exception — the package is
// installed, so the CLI approves them up front where pnpm allows it and never calls it a failure.
// These tests drive the real flow with a fake `pnpm` on PATH so no registry is touched.

let api
before(async () => {
  api = await startManagementApi()
})
after(async () => {
  await api.close()
})

// A fake pnpm ahead of the real one on PATH. It answers `--version` with `version`; any other call
// records its arguments next to itself and runs `onInstall` (output + exit code).
function makeFakePnpm({ version, onInstall }) {
  const dir = mkdtempSync(join(tmpdir(), 'fp-bin-'))
  const file = join(dir, 'pnpm')
  writeFileSync(
    file,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo ${version}; exit 0; fi
echo "$@" >> "$(dirname "$0")/args.log"
${onInstall}
`
  )
  chmodSync(file, 0o755)
  return { dir, args: () => (existsSync(join(dir, 'args.log')) ? readFileSync(join(dir, 'args.log'), 'utf8') : '') }
}

const BLOCKED_BUILDS = `echo " ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: @fingerprint/react@3.1.0." >&2
exit 1`

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

async function integrate({ home, repo, skillsDir, fakeBin, args = [], respond }) {
  const gw = await startGateway(join(repo, 'web', 'fingerprint.js'), '// integration\n')
  const res = await runCli(['integrate', '--yes', ...args], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gw.url, PATH: `${fakeBin}:${process.env.PATH}` },
    respond,
  })
  await gw.close()
  return res
}

test('pnpm 10.5+ gets the build scripts of the installed packages approved up front', async () => {
  const ctx = setup()
  const pnpm = makeFakePnpm({ version: '11.1.3', onInstall: 'exit 0' })

  const res = await integrate({ ...ctx, fakeBin: pnpm.dir })

  assert.equal(res.status, 0, `expected exit 0\n${res.stdout}\n${res.stderr}`)
  assert.match(pnpm.args(), /^add --allow-build=@fingerprint\/react @fingerprint\/react@latest$/m)
  assert.match(res.stdout, /Installed in web/)
})

test('older pnpm blocking the scripts is reported as installed, not as a failed integration', async () => {
  const ctx = setup()
  const pnpm = makeFakePnpm({ version: '10.4.0', onInstall: BLOCKED_BUILDS })

  const res = await integrate({ ...ctx, fakeBin: pnpm.dir })

  assert.equal(res.status, 0, `expected exit 0\n${res.stdout}\n${res.stderr}`)
  assert.doesNotMatch(pnpm.args(), /allow-build/)
  assert.match(res.stdout, /skipped the package's install scripts/)
  assert.match(res.stdout, /pnpm approve-builds/)
  assert.doesNotMatch(res.stdout, /code changes were applied/)
})

test('a real install failure fails the run', async () => {
  const ctx = setup()
  const pnpm = makeFakePnpm({ version: '11.1.3', onInstall: 'echo " ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/@fingerprint%2Freact: Not Found" >&2\nexit 1' })

  const res = await integrate({ ...ctx, fakeBin: pnpm.dir })

  assert.equal(res.status, 1, `expected exit 1\n${res.stdout}\n${res.stderr}`)
  // The run must not claim success when the packages the code needs are missing.
  assert.ok(!res.stdout.includes('Agent finished applying the integration'), res.stdout)
  assert.match(res.stdout, /code changes were applied/i)
  assert.match(res.stdout, /run manually/)

  const runs = api.analyticsEvents().filter((e) => e.body.event === 'cli_command_run')
  const run = runs[runs.length - 1]
  assert.equal(run.body.properties.status, 'error')
  assert.equal(run.body.properties.error_code, 'install_failed')
})

test('declining an interactive install is not a failure', async () => {
  const ctx = setup()
  // If the install runs despite being declined, the fake pnpm turns it into a loud failure.
  const pnpm = makeFakePnpm({ version: '11.1.3', onInstall: 'echo "should not have run" >&2\nexit 1' })

  const res = await integrate({
    ...ctx,
    fakeBin: pnpm.dir,
    args: ['--interactive'],
    respond: [
      { when: /create\/overwrite/, send: 'y\n' }, // allow the agent's Write
      { when: /Install @fingerprint\/react/, send: 'n\n' }, // decline the package install
    ],
  })

  assert.equal(res.status, 0, `expected exit 0\n${res.stdout}\n${res.stderr}`)
  assert.match(res.stdout, /Skipped — install manually/)
  assert.ok(!res.stdout.includes('should not have run'), 'declined install still executed pnpm')
})

function seedReactPackage(repo, available = true) {
  const manifest = join(repo, 'web', 'package.json')
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  pkg.dependencies['@fingerprint/react'] = '^3.0.0'
  writeFileSync(manifest, JSON.stringify(pkg))
  if (available) {
    const dir = join(repo, 'web', 'node_modules', '@fingerprint/react')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.js'), 'module.exports = {}\n')
  }
}

test('continuing the wizard does not reinstall packages already available to the app', async () => {
  const ctx = setup()
  seedReactPackage(ctx.repo)
  const pnpm = makeFakePnpm({ version: '11.1.3', onInstall: 'exit 1' })
  const gw = await startGateway(join(ctx.repo, 'web', 'fingerprint.js'), '// integration\n')
  try {
    const result = await runCli(['integrate'], {
      home: ctx.home,
      cwd: ctx.repo,
      env: { FINGERPRINT_SKILLS_DIR: ctx.skillsDir, FINGERPRINT_GATEWAY_URL: gw.url, PATH: `${pnpm.dir}:${process.env.PATH}` },
      respond: [
        { when: /Integrate Fingerprint into this repo/, send: 'y\n' },
        { when: /What's next\?/, send: '\n' },
        { when: /❯ (\x1b\[[0-9;]*m)*Protect against ad blockers/, send: '\x1b[B\n' },
      ],
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /Setting up server-side verification/)
    assert.doesNotMatch(result.stdout, /Installing @fingerprint/)
    assert.equal(pnpm.args(), '')
  } finally {
    await gw.close()
  }
})

test('a later run installs only the missing package, not the existing SDK', async () => {
  const ctx = setup()
  seedReactPackage(ctx.repo)
  ctx.skillsDir = makeSkillsDir({ 'fingerprint-react': ['@fingerprint/react', '@fingerprint/agent'] })
  const pnpm = makeFakePnpm({ version: '11.1.3', onInstall: 'exit 0' })
  const result = await integrate({ ...ctx, fakeBin: pnpm.dir })
  assert.equal(result.status, 0, result.stderr)
  assert.match(pnpm.args(), /^add --allow-build=@fingerprint\/agent @fingerprint\/agent@latest$/m)
  assert.doesNotMatch(pnpm.args(), /@fingerprint\/react/)
})

test('a package declared but unavailable after an incomplete install is installed again', async () => {
  const ctx = setup()
  seedReactPackage(ctx.repo, false)
  const pnpm = makeFakePnpm({ version: '11.1.3', onInstall: 'exit 0' })
  const result = await integrate({ ...ctx, fakeBin: pnpm.dir })
  assert.equal(result.status, 0, result.stderr)
  assert.match(pnpm.args(), /@fingerprint\/react@latest/)
})
