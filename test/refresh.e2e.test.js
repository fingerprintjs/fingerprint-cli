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
  finishBrowserLogin,
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

// In CI there's no one to drive a browser, so a dead session is a hard stop.
test('an expired token with no refresh token fails in CI before provisioning touches the repo', async () => {
  const home = makeHome()
  seedAuth(home, api.url, { accessToken: expiredJwt() })
  const repo = makeRepo()
  const skillsDir = makeSkillsDir()
  const auth = await startAuthServer()
  const gw = await startGateway(join(repo, 'web', 'fingerprint.js'), '// should never be written\n')

  const res = await runCli(['integrate', '--yes', '--ci'], { home, cwd: repo, env: integrateEnv(auth, gw, skillsDir) })
  await Promise.all([auth.close(), gw.close()])

  assert.notEqual(res.status, 0, 'expected a non-zero exit')
  // The dead session is reported as the styled failure block: the specific reason, then the recovery.
  const out = res.stderr + res.stdout
  assert.match(out, /session expired/i)
  assert.match(out, /fingerprint login/)
  // The point of the pre-flight: no keys provisioned, no files written, nothing to clean up.
  assert.ok(!existsSync(join(repo, 'web', '.env')), 'provisioned keys despite a dead session')
  assert.equal(gw.calls(), 0, 'called the gateway with a dead token')
})

// A refresh that can't reach the network rejects instead of returning a response, so it skips the
// HTTP-status branch. It used to surface as a bare "fetch failed"; it must name the real problem and
// must not be mistaken for a dead session, which would send the user at a browser round-trip that
// can't work either.
test('a refresh that cannot reach the login service says so, without claiming the session died', async () => {
  const home = makeHome()
  seedAuth(home, api.url, { accessToken: expiredJwt(), refreshToken: 'rt_1' })
  const repo = makeRepo()
  const skillsDir = makeSkillsDir()
  const auth = await startAuthServer({ deadTokenEndpoint: true })
  const gw = await startGateway(join(repo, 'web', 'fingerprint.js'), '// should never be written\n')

  const res = await runCli(['integrate', '--yes'], { home, cwd: repo, env: integrateEnv(auth, gw, skillsDir) })
  await Promise.all([auth.close(), gw.close()])

  assert.notEqual(res.status, 0, 'expected a non-zero exit')
  const out = res.stderr + res.stdout
  assert.doesNotMatch(out, /fetch failed/i)
  // The renew wording, not discoverEndpoints' — discovery answered fine here; the grant is what failed.
  assert.match(out, /reach the login service to renew your session/i)
  assert.doesNotMatch(out, /session expired/i)
  assert.equal(gw.calls(), 0, 'called the gateway without a live token')
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

// Interactive runs don't stop at a dead session: the command signs the user in and carries on. The
// loopback callback is driven by the test (see finishBrowserLogin); the fake auth server hands back a
// live token, and the run continues on it.
function signInEnv(auth, gw, skillsDir) {
  return { ...integrateEnv(auth, gw, skillsDir), FINGERPRINT_MANAGEMENT_API_URL: api.url, FINGERPRINT_NO_BROWSER: '1' }
}
const whenWaitingForBrowser = /Waiting for you to finish in the browser/

test('an expired token with no refresh token signs in through the browser, then integrates', async () => {
  const home = makeHome()
  seedAuth(home, api.url, { accessToken: expiredJwt() })
  const repo = makeRepo()
  const skillsDir = makeSkillsDir()
  const target = join(repo, 'web', 'fingerprint.js')
  const auth = await startAuthServer()
  const gw = await startGateway(target, '// fingerprint integration applied\n')

  const res = await runCli(['integrate', '--yes'], {
    home,
    cwd: repo,
    env: signInEnv(auth, gw, skillsDir),
    respond: [{ when: whenWaitingForBrowser, send: finishBrowserLogin }],
  })
  await Promise.all([auth.close(), gw.close()])

  assert.equal(res.status, 0, res.stderr)
  // Straight to sign-in: an expired session belongs to someone who has an account.
  assert.match(res.stdout, /Sign in/)
  assert.doesNotMatch(res.stdout, /Do you already have a Fingerprint account/)
  assert.doesNotMatch(res.stdout + res.stderr, /Can’t start the integration/)
  // The code exchange is the only grant; nothing tried to refresh a token that had no refresh token.
  assert.deepEqual(
    auth.grants().map((g) => g.grant_type),
    ['authorization_code']
  )
  assert.ok(existsSync(target), `agent did not write ${target}\n${res.stdout}\n${res.stderr}`)
})

test('bare fingerprint with an expired session goes straight to sign-in, then integrate', async () => {
  const home = makeHome()
  seedAuth(home, api.url, { accessToken: expiredJwt() })
  const repo = makeRepo()
  const skillsDir = makeSkillsDir()
  const auth = await startAuthServer()
  const gw = await startGateway(join(repo, 'web', 'fingerprint.js'), '// should never be written\n')

  const res = await runCli([], {
    home,
    cwd: repo,
    env: signInEnv(auth, gw, skillsDir),
    respond: [
      { when: whenWaitingForBrowser, send: finishBrowserLogin },
      // Reaching integrate's confirm proves sign-in chained into it; decline there.
      { when: /Integrate Fingerprint into this repo/, send: 'n\n' },
    ],
  })
  await Promise.all([auth.close(), gw.close()])

  assert.equal(res.status, 0, res.stderr)
  assert.doesNotMatch(res.stdout, /Signed in · workspace/)
  assert.doesNotMatch(res.stdout, /Do you already have a Fingerprint account/)
  assert.match(res.stdout, /Sign in/)
  assert.match(res.stdout, /Integrate Fingerprint into this repo/)
})

test('keys with no session asks login or signup, signs in, then prints the key', async () => {
  const auth = await startAuthServer()
  const res = await runCli(['keys', 'public'], {
    home: makeHome(),
    env: {
      FINGERPRINT_MANAGEMENT_API_URL: api.url,
      FINGERPRINT_OAUTH_ISSUER: auth.url,
      FINGERPRINT_OAUTH_CLIENT_ID: 'client_test',
      FINGERPRINT_NO_BROWSER: '1',
    },
    respond: [
      // Enter picks the first choice: "Yes — log in".
      { when: /Do you already have a Fingerprint account/, send: '\n' },
      { when: whenWaitingForBrowser, send: finishBrowserLogin },
    ],
  })
  await auth.close()

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /pub_123/)
})
