import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  startManagementApi,
  startGateway,
  startAuthServer,
  makeHome,
  seedAuth,
  makeRepo,
  makeSkillsDir,
  runCli,
  readAuth,
  expiredJwt,
  liveJwt,
} from './helpers/harness.js'

// Access tokens are short-lived, so a session has to survive its own access token expiring. These
// cover the three outcomes: renewable (refresh silently), not renewable (fail before touching the
// repo), and still valid (don't refresh at all).
let api
before(async () => {
  api = await startManagementApi()
})
after(async () => {
  await api.close()
})

function integrateEnv(auth, gw, skillsDir) {
  return {
    FINGERPRINT_SKILLS_DIR: skillsDir,
    FINGERPRINT_GATEWAY_URL: gw.url,
    FINGERPRINT_OAUTH_ISSUER: auth.url,
    FINGERPRINT_OAUTH_CLIENT_ID: 'client_test',
  }
}

test('an expired access token is refreshed and the rotated refresh token is persisted', async () => {
  const home = makeHome()
  seedAuth(home, api.url, { accessToken: expiredJwt(), refreshToken: 'rt_1' })
  const repo = makeRepo()
  const skillsDir = makeSkillsDir()
  const target = join(repo, 'web', 'fingerprint.js')
  const auth = await startAuthServer()
  const gw = await startGateway(target, '// fingerprint integration applied\n')

  const res = await runCli(['integrate', '--yes'], { home, cwd: repo, env: integrateEnv(auth, gw, skillsDir) })
  await Promise.all([auth.close(), gw.close()])

  assert.equal(res.status, 0, res.stderr)

  // It refreshed rather than sending the dead token on.
  const grants = auth.grants()
  assert.equal(grants.length, 1, `expected one refresh, got ${grants.length}`)
  assert.equal(grants[0].grant_type, 'refresh_token')
  assert.equal(grants[0].refresh_token, 'rt_1')
  assert.equal(grants[0].client_id, 'client_test')

  // The rotated refresh token replaced the spent one — otherwise the *next* run would fail.
  const saved = readAuth(home)
  assert.equal(saved.refreshToken, 'rt_rotated')
  assert.notEqual(saved.accessToken, expiredJwt())
  // Unrelated credentials survive the refresh.
  assert.equal(saved.managementApiKey, 'mgmt_key_1')

  // And the run actually completed on the new token.
  assert.ok(existsSync(target), `agent did not write ${target}\n${res.stdout}\n${res.stderr}`)
})

test('an expired token with no refresh token fails before provisioning touches the repo', async () => {
  const home = makeHome()
  seedAuth(home, api.url, { accessToken: expiredJwt() })
  const repo = makeRepo()
  const skillsDir = makeSkillsDir()
  const auth = await startAuthServer()
  const gw = await startGateway(join(repo, 'web', 'fingerprint.js'), '// should never be written\n')

  const res = await runCli(['integrate', '--yes'], { home, cwd: repo, env: integrateEnv(auth, gw, skillsDir) })
  await Promise.all([auth.close(), gw.close()])

  assert.notEqual(res.status, 0, 'expected a non-zero exit')
  assert.match(res.stderr + res.stdout, /session expired/i)
  // The point of the pre-flight: no keys provisioned, no files written, nothing to clean up.
  assert.ok(!existsSync(join(repo, 'web', '.env')), 'provisioned keys despite a dead session')
  assert.equal(gw.calls(), 0, 'called the gateway with a dead token')
})

test('a token that is still valid is used as-is, with no refresh round-trip', async () => {
  const home = makeHome()
  seedAuth(home, api.url, { accessToken: liveJwt(), refreshToken: 'rt_1' })
  const repo = makeRepo()
  const skillsDir = makeSkillsDir()
  const target = join(repo, 'web', 'fingerprint.js')
  const auth = await startAuthServer()
  const gw = await startGateway(target, '// fingerprint integration applied\n')

  const res = await runCli(['integrate', '--yes'], { home, cwd: repo, env: integrateEnv(auth, gw, skillsDir) })
  await Promise.all([auth.close(), gw.close()])

  assert.equal(res.status, 0, res.stderr)
  assert.equal(auth.grants().length, 0, 'refreshed a token that had not expired')
  assert.equal(readAuth(home).refreshToken, 'rt_1', 'rewrote the refresh token needlessly')
})
