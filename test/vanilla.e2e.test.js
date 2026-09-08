import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startManagementApi, startGateway, makeHome, seedAuth, makeVanillaRepo, makeStaticRepo, makeSkillsDir, runCli } from './helpers/harness.js'

// Browser code with no framework SDK is a supported stack: it resolves to `fingerprint-javascript`
// rather than dead-ending in "no supported app". The two shapes need different handling — a
// bundled app reads the key from .env like any other frontend, a static site has no env mechanism
// at all and gets the (public) key handed to the integration instead.
let api
before(async () => {
  api = await startManagementApi()
})
after(async () => {
  await api.close()
})

test('a bundled app with no framework dep resolves to fingerprint-javascript and gets the Vite env vars', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeVanillaRepo()
  const skillsDir = makeSkillsDir()
  const target = join(repo, 'fingerprint.js')
  const gw = await startGateway(target, '// fingerprint integration applied\n')

  const res = await runCli(['integrate', '--yes'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gw.url },
  })
  await gw.close()

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /fingerprint-javascript/)

  // The snippets read import.meta.env.VITE_*, so that's what has to be written.
  const env = readFileSync(join(repo, '.env'), 'utf8')
  assert.match(env, /VITE_FINGERPRINT_PUBLIC_API_KEY=pub_123/)
  assert.match(env, /VITE_FINGERPRINT_REGION=us/)

  assert.ok(existsSync(target), `agent did not write ${target}\n${res.stdout}\n${res.stderr}`)
})

test('a static site gets the public key in the prompt, no .env and no package.json', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeStaticRepo()
  // A real package name: the install must be skipped before any package manager runs, or a static
  // site ends up with the package.json (and node_modules) it deliberately doesn't have.
  const skillsDir = makeSkillsDir({ 'fingerprint-javascript': ['@fingerprint/agent'] })
  const gw = await startGateway(join(repo, 'index.html'), '<!-- integrated -->\n')

  const res = await runCli(['integrate', '--yes'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gw.url },
  })
  const bodies = gw.bodies()
  await gw.close()

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /fingerprint-javascript/)

  // Nothing reads a .env here, so writing one would be noise — and the CDN import URL needs the
  // literal key, which the agent can't get from a file it isn't allowed to read.
  assert.ok(!existsSync(join(repo, '.env')), 'wrote a .env a static site cannot read')
  assert.ok(!existsSync(join(repo, 'package.json')), 'created a package.json in a static site')
  assert.match(res.stdout, /No package.json in \./)

  assert.ok(bodies.length > 0, 'gateway was never called')
  assert.ok(bodies[0].includes('pub_123'), `public key was not handed to the agent:\n${bodies[0]}`)
  assert.ok(bodies[0].includes("region 'us'"), `region was not handed to the agent:\n${bodies[0]}`)
  // The secret key must never reach the model, inline values or not.
  assert.ok(!bodies.some((b) => b.includes('sec_456')), 'secret key leaked into the prompt')
})
