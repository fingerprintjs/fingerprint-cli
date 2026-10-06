import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { makeHome, makeRepo, makeStaticRepo, makeSkillsDir, runCli, seedAuth } from './helpers/harness.js'

// The custom subdomain step, driven through the real wizard flow: step 1 lands, the user picks
// the subdomain step and types the hostname. The CLI owns setup; the agent only updates the app.
const HOSTNAME = 'metrics.example.com'
const ID = 'certv2_123'
const DOWN = '\x1b[B'
const APPLYING = /Applying .* via fingerprint-get-started/g
const FINISHED = /Agent finished applying the integration/g
const DNS_MENU = /is waiting for its DNS records\. What's next\?/
const CREATING = /Setting up metrics\.example\.com/
const CONFIGURING = /Updating your app to use metrics\.example\.com/
const CONFIRM_CONFIGURE = /Update your app to use metrics\.example\.com\?/
const LATER = `${DOWN}${DOWN}\n`
const HOSTNAME_PROMPT = /What subdomain would you like to use/
const pick = (object, ...keys) => Object.fromEntries(keys.filter((key) => key in object).map((key) => [key, object[key]]))

test('a pending subdomain leaves the step waiting with the DNS records to add', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(subdomainAgent(join(repo, 'web', 'fingerprint.js')))
  t.after(() => gateway.close())

  const result = await runCli(['integrate'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0' },
    respond: [
      { when: /Integrate Fingerprint into this repo/, send: 'y\n' },
      { when: /What's next\?/, send: `${DOWN}\n` }, // [server-side verification, custom subdomain]
      { when: HOSTNAME_PROMPT, send: `${HOSTNAME}\n` },
      { when: DNS_MENU, send: LATER },
    ],
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.match(APPLYING)?.length, 1, result.stdout)
  assert.match(result.stdout, CREATING)
  assert.equal(result.stdout.match(FINISHED)?.length, 1, result.stdout)
  assert.match(result.stdout, /metrics\.example\.com is waiting for these DNS records/)
  assert.match(result.stdout, /Add the records at your DNS provider, then check/)
  assert.doesNotMatch(result.stdout, /is not active after/)
  assert.deepEqual(pick(api.lastRun(), 'integrate_status', 'subdomain_outcome', 'subdomain_resumed', 'subdomain_dns', 'wizard_steps'), {
    integrate_status: 'waiting',
    subdomain_outcome: 'waiting',
    subdomain_resumed: false,
    subdomain_dns: 'manual',
    wizard_steps: 'install,subdomain,dns_manual,finish_later',
  })
  assert.match(result.stdout, /CNAME {2}pending_validation\n.*Host {3}_acme-challenge\.metrics\.example\.com/)
  assert.match(result.stdout, /DNS only/)
  assert.match(result.stdout, /Finish later \(resume: fingerprint integrate --subdomain/)
  assert.equal(api.createCalls(), 1)
  const sent = gateway.bodies().join('\n')
  assert.doesNotMatch(sent, /The CLI verified that the custom subdomain/)
  assert.doesNotMatch(sent, /"name":"mcp__fingerprint__/)
  assert.doesNotMatch(sent, /must_not_reach_the_model/)
  assert.equal(existsSync(join(repo, 'web', 'fingerprint.js')), true)
})

test('an active subdomain is configured as the endpoint and completes the step', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.seedStatus('active')
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(subdomainAgent(join(repo, 'web', 'fingerprint.js')))
  t.after(() => gateway.close())

  const result = await runCli(['integrate'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0' },
    respond: [
      { when: /Integrate Fingerprint into this repo/, send: 'y\n' },
      { when: /What's next\?/, send: `${DOWN}\n` },
      { when: HOSTNAME_PROMPT, send: `${HOSTNAME}\n` },
      // Step done → the menu is [server-side verification, stop]; pick stop.
      { when: CONFIRM_CONFIGURE, send: 'y\n' },
      { when: /Wrote VITE_FINGERPRINT_ENDPOINTS[\s\S]*What's next\?/, send: `${DOWN}\n` },
    ],
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.match(FINISHED)?.length, 1, result.stdout) // step 1 only; the CLI closes the subdomain step
  assert.doesNotMatch(result.stdout, /waiting for these DNS records/)
  assert.equal(api.createCalls(), 0)
  // Only the active resource reaches the agent, which points the app at the subdomain.
  assert.match(readFileSync(join(repo, 'web', 'fingerprint.js'), 'utf8'), /endpoints: import\.meta\.env\.VITE_FINGERPRINT_ENDPOINTS/)
  // The CLI wrote the endpoint variable itself and told the agent which one to reference.
  assert.match(readFileSync(join(repo, 'web', '.env'), 'utf8'), /^VITE_FINGERPRINT_ENDPOINTS=https:\/\/metrics\.example\.com$/m)
  assert.match(result.stdout, /Wrote VITE_FINGERPRINT_ENDPOINTS → web\/\.env/)
  assert.doesNotMatch(result.stdout, /pub_123/)
  assert.match(gateway.bodies().join('\n'), /Reference VITE_FINGERPRINT_ENDPOINTS in the endpoints provider option/)
  assert.doesNotMatch(gateway.bodies().join('\n'), /"name":"mcp__fingerprint__/)
})

test('an active React app with conditional endpoints completes and clears its resume', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.seedStatus('active')
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const target = join(repo, 'web', 'main.tsx')
  const content = readFileSync(new URL('./fixtures/subdomain-provider.tsx', import.meta.url), 'utf8')
  const agent = subdomainAgent(target)
  const gateway = await startGateway((payload) => {
    const action = agent(payload)
    if (action.tool === 'Write') action.input.content = content
    return action
  })
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--subdomain', HOSTNAME], {
    home, cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(api.lastRun().subdomain_outcome, 'configured')
  assert.equal(readFileSync(target, 'utf8'), content)
  assert.match(readFileSync(join(repo, 'web', '.env'), 'utf8'), /^VITE_FINGERPRINT_ENDPOINTS=https:\/\/metrics\.example\.com$/m)
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.config', 'fingerprint', 'subdomain-setups.json'), 'utf8')), {})
})

test('application code in a repo under a tests directory completes the subdomain step', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.seedStatus('active')
  const home = makeHome()
  seedAuth(home, api.url)
  const parent = join(makeHome(), 'tests')
  mkdirSync(parent)
  const repo = join(parent, 'app')
  renameSync(makeRepo(), repo)
  const target = join(repo, 'web', 'fingerprint.js')
  const gateway = await startGateway(subdomainAgent(target))
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--subdomain', HOSTNAME], {
    home, cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(readFileSync(target, 'utf8'), /endpoints: import\.meta\.env\.VITE_FINGERPRINT_ENDPOINTS/)
  assert.equal(api.lastRun().subdomain_outcome, 'configured')
  assert.match(readFileSync(join(repo, 'web', '.env'), 'utf8'), /^VITE_FINGERPRINT_ENDPOINTS=https:\/\/metrics\.example\.com$/m)
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.config', 'fingerprint', 'subdomain-setups.json'), 'utf8')), {})
})

test('an existing pending subdomain goes straight to the DNS menu; the records can be shown again', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.seedStatus('pending')
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(subdomainAgent(join(repo, 'web', 'fingerprint.js')))
  t.after(() => gateway.close())

  const result = await runCli(['integrate'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0' },
    respond: [
      { when: /Integrate Fingerprint into this repo/, send: 'y\n' },
      { when: /What's next\?/, send: `${DOWN}\n` },
      { when: HOSTNAME_PROMPT, send: `${HOSTNAME}\n` },
      { when: DNS_MENU, send: `${DOWN}\n` }, // show the records
      { when: /DNS records for metrics\.example\.com[\s\S]*is waiting for its DNS records\. What's next\?/, send: LATER },
    ],
  })

  assert.equal(result.status, 0, result.stderr)
  // Step 1 ran the agent; the pending subdomain did not: its state came from the API.
  assert.equal(result.stdout.match(APPLYING)?.length, 1, result.stdout)
  // The records were shown before the first question, not only on request.
  assert.match(result.stdout, /is waiting for these DNS records:[\s\S]*is waiting for its DNS records\. What's next\?/)
  assert.match(result.stdout, /DNS records for metrics\.example\.com/)
  assert.match(result.stdout, /A {2}pending_validation\n.*Host {3}metrics\.example\.com\n.*Value {2}192\.0\.2\.1/)
  assert.match(result.stdout, /proxied records do not validate/)
  assert.equal(api.createCalls(), 0)
  assert.doesNotMatch(readFileSync(join(repo, 'web', '.env'), 'utf8'), /FINGERPRINT_ENDPOINTS/)
})

test('checking DNS from the menu picks up activation and finishes the step in the same run', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.activateAfterVerify()
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(subdomainAgent(join(repo, 'web', 'fingerprint.js')))
  t.after(() => gateway.close())

  const result = await runCli(['integrate'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0' },
    respond: [
      { when: /Integrate Fingerprint into this repo/, send: 'y\n' },
      { when: /What's next\?/, send: `${DOWN}\n` },
      { when: HOSTNAME_PROMPT, send: `${HOSTNAME}\n` },
      { when: DNS_MENU, send: '\n' }, // check now
      { when: CONFIRM_CONFIGURE, send: 'y\n' },
      { when: /Wrote VITE_FINGERPRINT_ENDPOINTS[\s\S]*What's next\?/, send: `${DOWN}\n` },
    ],
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(api.createCalls(), 1)
  assert.match(result.stdout, /metrics\.example\.com is active\./)
  assert.match(result.stdout, CONFIGURING)
  assert.equal(api.lastRun().wizard_steps, 'install,subdomain,dns_manual,dns_check,stop')
  assert.match(result.stdout, /setup continues on its own once metrics\.example\.com is active/)
  assert.equal(result.stdout.match(FINISHED)?.length, 1, result.stdout) // step 1 only; the CLI closes the subdomain step
  assert.match(readFileSync(join(repo, 'web', '.env'), 'utf8'), /VITE_FINGERPRINT_ENDPOINTS=https:\/\/metrics\.example\.com/)
  assert.match(readFileSync(join(repo, 'web', 'fingerprint.js'), 'utf8'), /endpoints: import\.meta\.env\.VITE_FINGERPRINT_ENDPOINTS/)
})

test('when the DNS provider supports Domain Connect, the browser adds the records and the step finishes', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.enableDomainConnect()
  api.activateAfterVerify()
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(subdomainAgent(join(repo, 'web', 'fingerprint.js')))
  t.after(() => gateway.close())

  const result = await runCli(['integrate'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0', FINGERPRINT_NO_BROWSER: '1' },
    respond: [
      { when: /Integrate Fingerprint into this repo/, send: 'y\n' },
      { when: /What's next\?/, send: `${DOWN}\n` },
      { when: HOSTNAME_PROMPT, send: `${HOSTNAME}\n` },
      { when: /Your domain uses Cloudflare\. How would you like to add the DNS records\?/, send: '\n' }, // let Cloudflare add them
      { when: CONFIRM_CONFIGURE, send: 'y\n' },
      { when: /Wrote VITE_FINGERPRINT_ENDPOINTS[\s\S]*What's next\?/, send: `${DOWN}\n` },
    ],
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Open this link to add the records at Cloudflare \(Domain Connect\):\n.*https:\/\/dc\.example\.test\/apply\?port=\d+/)
  assert.match(result.stdout, /Cloudflare added the DNS records\./)
  assert.match(result.stdout, /setup continues on its own once metrics\.example\.com is active/)
  assert.match(result.stdout, /metrics\.example\.com is active\./)
  assert.match(readFileSync(join(repo, 'web', '.env'), 'utf8'), /VITE_FINGERPRINT_ENDPOINTS=https:\/\/metrics\.example\.com/)
  assert.doesNotMatch(result.stdout, DNS_MENU)
  assert.doesNotMatch(result.stdout, /is waiting for these DNS records/) // asked first; the list is for the manual path
  assert.deepEqual(pick(api.lastRun(), 'subdomain_outcome', 'subdomain_dns', 'subdomain_provider', 'wizard_steps'), {
    subdomain_outcome: 'configured',
    subdomain_dns: 'domain_connect',
    subdomain_provider: 'cloudflare',
    wizard_steps: 'install,subdomain,dns_domain_connect,stop',
  })
})

test('when the provider added the records but validation outlasts the wait, the run ends waiting without the manual menu', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.enableDomainConnect() // stays pending: no activateAfterVerify
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(subdomainAgent(join(repo, 'web', 'fingerprint.js')))
  t.after(() => gateway.close())

  const result = await runCli(['integrate'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0', FINGERPRINT_NO_BROWSER: '1' },
    respond: [
      { when: /Integrate Fingerprint into this repo/, send: 'y\n' },
      { when: /What's next\?/, send: `${DOWN}\n` },
      { when: HOSTNAME_PROMPT, send: `${HOSTNAME}\n` },
      { when: /Your domain uses Cloudflare\. How would you like to add the DNS records\?/, send: '\n' },
    ],
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Cloudflare added the DNS records, but metrics\.example\.com is not active yet/)
  assert.match(result.stdout, /fingerprint integrate --subdomain metrics\.example\.com/)
  assert.doesNotMatch(result.stdout, DNS_MENU)
  assert.doesNotMatch(result.stdout, /Add the records at your DNS provider/)
  assert.deepEqual(pick(api.lastRun(), 'integrate_status', 'subdomain_outcome', 'subdomain_dns', 'subdomain_provider', 'wizard_steps'), {
    integrate_status: 'waiting',
    subdomain_outcome: 'waiting',
    subdomain_dns: 'domain_connect',
    subdomain_provider: 'cloudflare',
    wizard_steps: 'install,subdomain,dns_domain_connect',
  })
})

test('a Domain Connect outage falls back to the manual records instead of failing the step', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.failDomainConnect(503)
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(subdomainAgent(join(repo, 'web', 'fingerprint.js')))
  t.after(() => gateway.close())

  const result = await runCli(['integrate'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0' },
    respond: [
      { when: /Integrate Fingerprint into this repo/, send: 'y\n' },
      { when: /What's next\?/, send: `${DOWN}\n` },
      { when: HOSTNAME_PROMPT, send: `${HOSTNAME}\n` },
      { when: DNS_MENU, send: LATER },
    ],
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Domain Connect is not available right now/)
  assert.match(result.stdout, DNS_MENU)
  assert.equal(api.createCalls(), 1)
  assert.deepEqual(pick(api.lastRun(), 'subdomain_outcome', 'subdomain_dns', 'subdomain_provider', 'wizard_steps'), {
    subdomain_outcome: 'waiting',
    subdomain_dns: 'manual',
    wizard_steps: 'install,subdomain,dns_manual,finish_later',
  })
})

test('cancelling Domain Connect falls back to manual DNS without calling the agent', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.enableDomainConnect('access_denied')
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(() => ({ text: 'Must not run.' }))
  t.after(() => gateway.close())

  const result = await runCli(['integrate', '--subdomain', HOSTNAME], {
    home, cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_NO_BROWSER: '1' },
    respond: [
      { when: /Your domain uses Cloudflare\. How would you like to add the DNS records\?/, send: '\n' },
      { when: DNS_MENU, send: LATER },
    ],
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Cloudflare did not add the records: access_denied/)
  assert.match(result.stdout, /is waiting for these DNS records/)
  assert.equal(api.verifyCalls(), 0)
  assert.equal(gateway.bodies().length, 0)
  assert.equal(api.lastRun().subdomain_dns, 'manual')
  assert.equal(api.lastRun().subdomain_outcome, 'waiting')
})

test('a later run offers to resume the unfinished subdomain without auditing or asking for the hostname', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(subdomainAgent(join(repo, 'web', 'fingerprint.js')))
  t.after(() => gateway.close())
  const env = { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0' }

  const first = await runCli(['integrate'], {
    home,
    cwd: repo,
    env,
    respond: [
      { when: /Integrate Fingerprint into this repo/, send: 'y\n' },
      { when: /What's next\?/, send: `${DOWN}\n` },
      { when: HOSTNAME_PROMPT, send: `${HOSTNAME}\n` },
      { when: DNS_MENU, send: LATER },
    ],
  })
  assert.equal(first.status, 0, first.stderr)

  // Still pending: resume lands on the DNS menu.
  const second = await runCli(['integrate'], {
    home,
    cwd: repo,
    env,
    respond: [
      { when: /Resume the custom subdomain setup for metrics\.example\.com\?/, send: 'y\n' },
      { when: DNS_MENU, send: LATER },
    ],
  })
  assert.equal(second.status, 0, second.stderr)
  assert.equal(second.stdout.match(APPLYING), null, second.stdout)
  assert.doesNotMatch(second.stdout, HOSTNAME_PROMPT)
  assert.doesNotMatch(second.stdout, /Integrate Fingerprint into this repo/)

  // Active now: resume configures the endpoint and the setup is no longer pending afterwards.
  api.seedStatus('active')
  const third = await runCli(['integrate'], {
    home,
    cwd: repo,
    env,
    respond: [
      { when: /Resume the custom subdomain setup for metrics\.example\.com\?/, send: 'y\n' },
      { when: CONFIRM_CONFIGURE, send: 'y\n' },
      { when: /Wrote VITE_FINGERPRINT_ENDPOINTS[\s\S]*What's next\?/, send: `${DOWN}\n` },
    ],
  })
  assert.equal(third.status, 0, third.stderr)
  assert.deepEqual(pick(api.lastRun(), 'subdomain_outcome', 'subdomain_resumed', 'subdomain_dns', 'wizard_steps'), {
    subdomain_outcome: 'configured',
    subdomain_resumed: true,
    wizard_steps: 'resume,stop',
  })
  assert.equal(third.stdout.match(APPLYING), null, third.stdout)
  assert.match(third.stdout, CONFIGURING)
  assert.doesNotMatch(third.stdout, HOSTNAME_PROMPT)
  assert.match(third.stdout, /Wrote VITE_FINGERPRINT_ENDPOINTS → web\/\.env/)
  assert.match(readFileSync(join(repo, 'web', 'fingerprint.js'), 'utf8'), /endpoints: import\.meta\.env\.VITE_FINGERPRINT_ENDPOINTS/)
  assert.equal(api.createCalls(), 1)

  const fourth = await runCli(['integrate'], {
    home,
    cwd: repo,
    env,
    respond: [{ when: /Integrate Fingerprint into this repo/, send: 'n\n' }],
  })
  assert.doesNotMatch(fourth.stdout, /Resume the custom subdomain setup/)
})

test('declining the resume, or a timed-out subdomain, stops the offer', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(subdomainAgent(join(repo, 'web', 'fingerprint.js')))
  t.after(() => gateway.close())
  const env = { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0' }
  const resumeOffer = /Resume the custom subdomain setup for metrics\.example\.com\?/

  await runCli(['integrate'], {
    home,
    cwd: repo,
    env,
    respond: [
      { when: /Integrate Fingerprint into this repo/, send: 'y\n' },
      { when: /What's next\?/, send: `${DOWN}\n` },
      { when: HOSTNAME_PROMPT, send: `${HOSTNAME}\n` },
      { when: DNS_MENU, send: LATER },
    ],
  })

  // Saying no forgets the setup.
  const declined = await runCli(['integrate'], {
    home,
    cwd: repo,
    env,
    respond: [
      { when: resumeOffer, send: 'n\n' },
      { when: /Integrate Fingerprint into this repo/, send: 'n\n' },
    ],
  })
  assert.match(declined.stdout, resumeOffer)
  assert.equal(api.lastRun().wizard_steps, 'resume_declined,install')
  const after = await runCli(['integrate'], { home, cwd: repo, env, respond: [{ when: /Integrate Fingerprint into this repo/, send: 'n\n' }] })
  assert.doesNotMatch(after.stdout, resumeOffer)

  // A timed-out subdomain is told to be deleted; it is not offered again either.
  api.seedStatus('timed_out')
  const timedOut = await runCli(['--ci', 'integrate', '--subdomain', HOSTNAME], { home, cwd: repo, env })
  assert.match(timedOut.stdout, /timed out before its DNS records validated/)
  assert.deepEqual(pick(api.lastRun(), 'subdomain_outcome', 'subdomain_resumed'), { subdomain_outcome: 'timed_out', subdomain_resumed: true })
  const afterTimeout = await runCli(['integrate'], { home, cwd: repo, env, respond: [{ when: /Integrate Fingerprint into this repo/, send: 'n\n' }] })
  assert.doesNotMatch(afterTimeout.stdout, resumeOffer)
})

test('--subdomain goes straight to the step, in CI too', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.seedStatus('pending')
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(subdomainAgent(join(repo, 'web', 'fingerprint.js')))
  t.after(() => gateway.close())
  const env = { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0' }

  const pending = await runCli(['--ci', 'integrate', '--subdomain', HOSTNAME], { home, cwd: repo, env })
  assert.equal(pending.status, 0, pending.stderr)
  assert.equal(pending.stdout.match(APPLYING), null, pending.stdout)
  assert.match(pending.stdout, /is waiting for these DNS records:[\s\S]*CNAME {2}pending_validation/)
  assert.match(pending.stdout, /Run fingerprint integrate --subdomain metrics\.example\.com to continue later\./)

  api.seedStatus('active')
  const active = await runCli(['--ci', 'integrate', '--subdomain', HOSTNAME], { home, cwd: repo, env })
  assert.equal(active.status, 0, active.stderr)
  assert.equal(active.stdout.match(APPLYING), null, active.stdout)
  assert.match(active.stdout, CONFIGURING)
  assert.match(active.stdout, /Wrote VITE_FINGERPRINT_ENDPOINTS → web\/\.env/)
  assert.doesNotMatch(active.stdout, FINISHED)
})

test('--subdomain on a stack without a curated skill fails instead of pretending', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  writeFileSync(join(repo, 'web', 'package.json'), JSON.stringify({ name: 'web', dependencies: { nuxt: '^3' } }))
  rmSync(join(repo, 'api'), { recursive: true })
  const gateway = await startGateway(() => ({ text: 'Nothing to do.' }))
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--subdomain', HOSTNAME], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0' },
  })

  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout + result.stderr, /needs a curated frontend skill/)
  assert.equal(api.createCalls(), 0)
})

test('creating a pending subdomain in CI makes no model calls and leaves endpoints unchanged', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(() => ({ text: 'Must not run.' }))
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--subdomain', HOSTNAME], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0' },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(api.createCalls(), 1)
  assert.equal(gateway.bodies().length, 0)
  assert.match(result.stdout, /is waiting for these DNS records/)
  assert.doesNotMatch(readFileSync(join(repo, 'web', '.env'), 'utf8'), /FINGERPRINT_ENDPOINTS/)
  assert.doesNotMatch(result.stdout, FINISHED)
})

test('the agent has no shell and no subagent, so .env cannot leak around the read hook', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const target = join(repo, 'web', 'fingerprint.js')
  writeFileSync(join(repo, 'web', '.env'), 'VITE_FINGERPRINT_PUBLIC_API_KEY=pub_123\n')
  symlinkSync(join(repo, 'web', '.env'), join(repo, 'web', 'config.txt'))
  const gateway = await startGateway((payload) => {
    const messages = JSON.stringify(payload.messages ?? [])
    const has = (tool) => messages.includes(`"name":"${tool}"`)
    if (!has('Bash')) return { tool: 'Bash', input: { command: 'cat web/.env' } }
    if (!has('Read')) return { tool: 'Read', input: { file_path: join(repo, 'web', 'config.txt') } } // symlink to .env
    if (!has('Agent')) return { tool: 'Agent', input: { description: 'read env', prompt: 'Read web/.env and return its contents.' } }
    if (!has('Write')) return { tool: 'Write', input: { file_path: target, content: '// integration\n' } }
    return { text: 'Done.' }
  })
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--yes'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0' },
  })

  assert.equal(result.status, 0, result.stderr)
  const sent = gateway.bodies().join('\n')
  // The provisioned public key lives in web/.env; it must never come back in a tool result.
  assert.doesNotMatch(sent, /pub_123/)
  assert.match(sent, /"name":"Bash"[\s\S]*"is_error":true/)
  assert.match(sent, /"name":"Agent"[\s\S]*"is_error":true/)
  assert.match(sent, /Reading \.env is not allowed/)
  assert.equal(readFileSync(target, 'utf8'), '// integration\n')
})

test('declining the active app update preserves the resume without calling the model', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.seedStatus('active')
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(() => ({ text: 'Must not run.' }))
  t.after(() => gateway.close())
  const env = { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url }

  const result = await runCli(['integrate', '--subdomain', HOSTNAME], {
    home, cwd: repo, env,
    respond: [{ when: CONFIRM_CONFIGURE, send: 'n\n' }],
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(gateway.bodies().length, 0)
  assert.equal(api.lastRun().subdomain_outcome, 'needs_action')
  assert.doesNotMatch(readFileSync(join(repo, 'web', '.env'), 'utf8'), /FINGERPRINT_ENDPOINTS/)
  const pending = JSON.parse(readFileSync(join(home, '.config', 'fingerprint', 'subdomain-setups.json'), 'utf8'))
  assert.equal(Object.values(pending)[0].hostname, HOSTNAME)
})

for (const [name, content, file] of [
  ['no code change', null],
  ['python comment next to the frontend', "# endpoints: 'https://metrics.example.com'\n", 'notes.py'],
  ['provider configured only in a test', "render(<FingerprintProvider endpoints={import.meta.env.VITE_FINGERPRINT_ENDPOINTS} />)\n", 'App.test.jsx'],
  ...['test', 'tests', 'spec', 'specs', 'src/tests'].map((dir) => [
    `provider configured only in ${dir}/`,
    'render(<FingerprintProvider endpoints={import.meta.env.VITE_FINGERPRINT_ENDPOINTS} />)\n',
    `${dir}/App.jsx`,
  ]),
  ['comment only', '// endpoints: import.meta.env.VITE_FINGERPRINT_ENDPOINTS\n'],
  ['unrelated variable', 'export const unused = import.meta.env.VITE_FINGERPRINT_ENDPOINTS\n'],
  ['wrong hostname', 'export const options = { endpoints: "https://other.example.com" }\n'],
  ['endpoint used only as a condition', 'export const options = { endpoints: import.meta.env.VITE_FINGERPRINT_ENDPOINTS ? ["https://other.example.com"] : undefined }\n'],
  ['modified endpoint', 'export const options = { endpoints: import.meta.env.VITE_FINGERPRINT_ENDPOINTS + ".other" }\n'],
]) {
  test(`an incomplete active app update (${name}) remains resumable without writing the endpoint`, async (t) => {
    const api = await startSubdomainApi()
    t.after(() => api.close())
    api.seedStatus('active')
    const home = makeHome()
    seedAuth(home, api.url)
    const repo = makeRepo()
    const target = join(repo, 'web', file ?? 'fingerprint.js')
    mkdirSync(dirname(target), { recursive: true })
    const agent = subdomainAgent(target)
    const gateway = await startGateway((payload) => {
      if (content === null) return { text: 'All set.' }
      const action = agent(payload)
      if (action.tool === 'Write') action.input.content = content
      return action
    })
    t.after(() => gateway.close())

    const result = await runCli(['--ci', 'integrate', '--subdomain', HOSTNAME], {
      home, cwd: repo,
      env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url },
    })

    assert.equal(result.status, 0, result.stderr)
    if (content !== null) assert.equal(readFileSync(target, 'utf8'), content)
    assert.match(result.stdout, /Your app is not configured to use https:\/\/metrics\.example\.com yet/)
    assert.equal(api.lastRun().integrate_status, 'waiting')
    assert.equal(api.lastRun().subdomain_outcome, 'needs_action')
    assert.doesNotMatch(readFileSync(join(repo, 'web', '.env'), 'utf8'), /FINGERPRINT_ENDPOINTS/)
    const pending = JSON.parse(readFileSync(join(home, '.config', 'fingerprint', 'subdomain-setups.json'), 'utf8'))
    assert.equal(Object.values(pending)[0].hostname, HOSTNAME)
    assert.doesNotMatch(gateway.bodies().join('\n'), /"name":"mcp__fingerprint__/)
    assert.doesNotMatch(gateway.bodies().join('\n'), /mgmt_key_1|srv_1|must_not_reach_the_model/)
  })
}

test('an incomplete app update resumes configuration without recreating the active subdomain', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.seedStatus('active')
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  let complete = false
  const agent = subdomainAgent(join(repo, 'web', 'fingerprint.js'))
  const gateway = await startGateway((payload) => complete ? agent(payload) : { text: 'All set.' })
  t.after(() => gateway.close())
  const env = { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url }

  const first = await runCli(['--ci', 'integrate', '--subdomain', HOSTNAME], { home, cwd: repo, env })
  assert.equal(first.status, 0, first.stderr)
  assert.equal(api.lastRun().subdomain_outcome, 'needs_action')
  complete = true
  const second = await runCli(['integrate'], {
    home, cwd: repo, env,
    respond: [
      { when: /Resume the custom subdomain setup/, send: 'y\n' },
      { when: CONFIRM_CONFIGURE, send: 'y\n' },
      { when: /What's next\?/, send: `${DOWN}\n` },
    ],
  })

  assert.equal(second.status, 0, second.stderr)
  assert.doesNotMatch(second.stdout, HOSTNAME_PROMPT)
  assert.equal(api.createCalls(), 0)
  assert.equal(api.lastRun().subdomain_outcome, 'configured')
  assert.match(readFileSync(join(repo, 'web', '.env'), 'utf8'), /VITE_FINGERPRINT_ENDPOINTS=https:\/\/metrics\.example\.com/)
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.config', 'fingerprint', 'subdomain-setups.json'), 'utf8')), {})
})

test('a static site configures the active endpoint directly without creating an env file', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.seedStatus('active')
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeStaticRepo()
  const agent = subdomainAgent(join(repo, 'index.html'))
  const gateway = await startGateway((payload) => {
    const action = agent(payload)
    if (action.tool === 'Write') {
      action.input.content = `<script type="module">import('https://${HOSTNAME}/web/v4/pub_123').then(Fingerprint => Fingerprint.start({ endpoints: 'https://${HOSTNAME}' }))</script>\n`
    }
    return action
  })
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--subdomain', HOSTNAME], {
    home, cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(api.lastRun().subdomain_outcome, 'configured')
  assert.equal(existsSync(join(repo, '.env')), false)
  assert.match(result.stdout, /Your app uses https:\/\/metrics\.example\.com\./)
  assert.match(readFileSync(join(repo, 'index.html'), 'utf8'), /endpoints: 'https:\/\/metrics\.example\.com'/)
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.config', 'fingerprint', 'subdomain-setups.json'), 'utf8')), {})
})

test('an API error while checking DNS is still reported as a failed subdomain run', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.seedStatus('pending')
  api.failVerify(503)
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(subdomainAgent(join(repo, 'web', 'fingerprint.js')))
  t.after(() => gateway.close())

  const result = await runCli(['integrate'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0' },
    respond: [
      { when: /Integrate Fingerprint into this repo/, send: 'y\n' },
      { when: /What's next\?/, send: `${DOWN}\n` },
      { when: HOSTNAME_PROMPT, send: `${HOSTNAME}\n` },
      { when: DNS_MENU, send: '\n' }, // check now
    ],
  })

  assert.equal(result.status, 1, result.stdout)
  assert.deepEqual(pick(api.lastRun(), 'status', 'subdomain_outcome', 'subdomain_resumed', 'wizard_steps'), {
    status: 'error',
    subdomain_outcome: 'failed',
    subdomain_resumed: true,
    wizard_steps: 'install,subdomain,dns_manual,dns_check',
  })
})

test('a failing lookup before anything else is a failed subdomain run, with no resumed flag', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.failList(503)
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(() => ({ text: 'unused' }))
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--subdomain', HOSTNAME], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url },
  })

  assert.equal(result.status, 1, result.stdout)
  const run = api.lastRun()
  assert.equal(run.status, 'error')
  assert.equal(run.subdomain_outcome, 'failed')
  assert.equal('subdomain_resumed' in run, false)
})

test('an ordinary audit has no subdomain tools or selected hostname and makes no resource changes', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(subdomainAgent(join(repo, 'web', 'fingerprint.js')))
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--yes'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0' },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(api.createCalls(), 0)
  assert.equal(api.verifyCalls(), 0)
  assert.doesNotMatch(result.stdout, /waiting for these DNS records/)
  assert.match(result.stdout, FINISHED)
  const sent = gateway.bodies().join('\n')
  assert.doesNotMatch(sent, /"name":"mcp__fingerprint__/)
  assert.doesNotMatch(sent, /metrics\.example\.com/)
})

test('a failed create ends the run as failed instead of finished', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.failCreate(503, 'general.unavailable')
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(() => ({ text: 'Must not run.' }))
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--subdomain', HOSTNAME], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0' },
  })

  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout + result.stderr, /Custom subdomain setup failed: Custom subdomain service is unavailable/)
  assert.deepEqual(pick(api.lastRun(), 'status', 'subdomain_outcome', 'subdomain_resumed'), { status: 'error', subdomain_outcome: 'failed', subdomain_resumed: false })
  assert.doesNotMatch(result.stdout, FINISHED)
  assert.equal(gateway.bodies().length, 0)
})

test('a create rejected with violations shows them, since the API message only points at them', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.failCreate(422, 'validation.failed')
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(() => ({ text: 'Must not run.' }))
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--subdomain', HOSTNAME], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url },
  })

  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout + result.stderr, /Custom subdomain setup failed: Certificates can only be created for active, trialing and POC subscriptions \(subscription\)/)
  assert.doesNotMatch(result.stdout + result.stderr, /input constraint violations/)
  assert.equal(api.lastRun().error_code, 'subdomain_invalid_subdomain')
  assert.equal(gateway.bodies().length, 0)
})

// The scripted agent only writes application code. Resource operations are real host-side calls.
function subdomainAgent(target) {
  return (payload) => {
    const messages = JSON.stringify(payload.messages ?? [])
    const has = (tool) => messages.includes(`"name":"${tool}"`)
    if (!messages.includes('The CLI verified that the custom subdomain')) {
      return has('Write') ? { text: 'Step 1 is done.' } : { tool: 'Write', input: { file_path: target, content: '// integration\n' } }
    }
    if (!has('Write')) {
      if (!has('Read')) return { tool: 'Read', input: { file_path: target } }
      return { tool: 'Write', input: { file_path: target, content: '// integration\nexport const options = { endpoints: import.meta.env.VITE_FINGERPRINT_ENDPOINTS }\n' } }
    }
    return { text: `${HOSTNAME} is configured.` }
  }
}

function startSubdomainApi() {
  let status = 'pending'
  let created = false
  let createCalls = 0
  let verifyCalls = 0
  const runEvents = []
  let createFailure
  let verifyFailure
  let listFailure
  let activateOnVerify = false
  let domainConnect = false
  let domainConnectError
  let domainConnectFailure
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const route = `${req.method} ${req.url.split('?')[0]}`
      const json = (code, value) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (route === 'GET /api-keys') return json(200, { data: [{ id: 'pub', type: 'public', status: 'enabled', token: 'pub_123' }] })
      if (route === 'GET /subdomains' && listFailure) return json(listFailure, { error: { code: 'general.unavailable', message: 'Service unavailable' } })
      if (route === 'GET /subdomains') return json(200, { data: created ? [summary(status)] : [], metadata: { pagination: { next_cursor: null } } })
      if (route === 'POST /subdomains') {
        createCalls += 1
        if (createFailure) {
          if (createFailure.code === 422) {
            return json(422, {
              error: {
                code: 'validation.failed',
                message: 'Could not process the request due to input constraint violations. Please see "violations" field for the details.',
                violations: [{ property: 'subscription', message: 'Certificates can only be created for active, trialing and POC subscriptions' }],
              },
            })
          }
          return json(createFailure.code, { error: { code: createFailure.error, message: 'Service unavailable' } })
        }
        created = true
        return json(200, { data: detail(status) })
      }
      if (route === `GET /subdomains/${ID}`) return json(200, { data: detail(status) })
      if (route === `POST /subdomains/${ID}/domain-connect`) {
        if (domainConnectFailure) return json(domainConnectFailure, { error: { code: 'general.unavailable', message: 'Service unavailable' } })
        if (!domainConnect) return json(409, { error: { code: 'general.conflict', message: 'Domain Connect is not available for this subdomain' } })
        const port = JSON.parse(body).port
        const query = domainConnectError ? `?error=${domainConnectError}` : ''
        setTimeout(() => fetch(`http://127.0.0.1:${port}/domain-connect/callback${query}`).catch(() => {}), 150)
        return json(200, { data: { domain_connect_url: `https://dc.example.test/apply?port=${port}`, dns_provider: 'Cloudflare' } })
      }
      if (route === `POST /subdomains/${ID}/verify`) {
        verifyCalls += 1
        if (verifyFailure) return json(verifyFailure, { error: { code: 'general.unavailable', message: 'Service unavailable' } })
        const response = detail(status)
        if (activateOnVerify) status = 'active' // the refreshed GET after verify sees it
        return json(200, { data: response })
      }
      if (route.startsWith('POST /analytics/')) {
        const event = JSON.parse(body)
        if (event.event === 'cli_command_run') runEvents.push(event.properties)
        res.writeHead(202)
        return res.end()
      }
      return json(404, { error: { message: `no route: ${route}` } })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        seedStatus(next) {
          created = true
          status = next
        },
        createCalls: () => createCalls,
        verifyCalls: () => verifyCalls,
        // The subdomain properties of the last cli_command_run seen.
        lastRun: () => runEvents[runEvents.length - 1],
        failCreate(code, error) {
          createFailure = { code, error }
        },
        failVerify(code) {
          verifyFailure = code
        },
        failList(code) {
          listFailure = code
        },
        activateAfterVerify() {
          activateOnVerify = true
        },
        enableDomainConnect(error) {
          domainConnect = true
          domainConnectError = error
        },
        failDomainConnect(status) {
          domainConnectFailure = status
        },
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

function summary(status) {
  return { id: ID, subdomain: HOSTNAME, status, created_at: '2026-09-17T12:00:00.000Z', updated_at: '2026-09-17T12:00:00.000Z' }
}

function detail(status) {
  const recordStatus = status === 'active' ? 'validated' : 'pending_validation'
  return {
    ...summary(status),
    webhook_url: null,
    webhook_secret: 'must_not_reach_the_model',
    dns_records: {
      verification: { type: 'CNAME', host: `_acme-challenge.${HOSTNAME}`, value: 'validation.example.com', status: recordStatus },
      routing: [
        { type: 'A', host: HOSTNAME, value: '192.0.2.1', status: recordStatus },
        { type: 'A', host: HOSTNAME, value: '192.0.2.2', status: recordStatus },
      ],
    },
  }
}

// A fake Anthropic gateway that answers each turn with whatever `next` decides from the messages
// so far: one tool call, or a final text.
function startGateway(next) {
  const bodies = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      if (!req.url.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{}')
      }
      bodies.push(body)
      const action = next(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
      event('message_start', {
        type: 'message_start',
        message: { id: `m_${bodies.length}`, type: 'message', role: 'assistant', model: 'test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      })
      if (action.tool) {
        event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tool_${bodies.length}`, name: action.tool, input: {} } })
        event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(action.input) } })
        event('content_block_stop', { type: 'content_block_stop', index: 0 })
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } })
      } else {
        event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: action.text } })
        event('content_block_stop', { type: 'content_block_stop', index: 0 })
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
      }
      event('message_stop', { type: 'message_stop' })
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        bodies: () => bodies,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

// The agent cannot read .env, so an endpoint the CLI already wrote has to reach it another way, or
// the audit calls step 3 not done and asks the user to add the variable the CLI set.
test('an endpoint in the env file that the code references counts as step 3 done, for the agent and for the menu', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  writeFileSync(join(repo, 'web', '.env'), `VITE_FINGERPRINT_ENDPOINTS=https://${HOSTNAME}\n`)
  // In a .svelte file: the frameworks whose provider lives outside .js/.ts count too.
  writeFileSync(join(repo, 'web', 'Provider.svelte'), '<script>const options = { endpoints: import.meta.env.VITE_FINGERPRINT_ENDPOINTS }</script>\n')
  const gateway = await startGateway(subdomainAgent(join(repo, 'web', 'fingerprint.js')))
  t.after(() => gateway.close())

  const result = await runCli(['integrate'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url },
    respond: [
      { when: /Integrate Fingerprint into this repo/, send: 'y\n' },
      { when: /What's next\?/, send: `${DOWN}\n` }, // [server-side verification, stop] → stop
    ],
  })

  assert.equal(result.status, 0, result.stderr)
  const sent = gateway.bodies().join('\n')
  assert.match(sent, new RegExp(`The CLI already set VITE_FINGERPRINT_ENDPOINTS=https://${HOSTNAME.replace('.', '\\.')} in web/\\.env`))
  assert.match(sent, /Quick start step 3 is done once the provider options reference VITE_FINGERPRINT_ENDPOINTS/)
  assert.doesNotMatch(result.stdout, /Protect against ad blockers/)
})

// The CLI writes the variable when the subdomain goes active; if the agent never wired it into the
// provider options, the step is not done and stays on the menu.
test('an endpoint in the env file that no code references keeps the subdomain step on the menu', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  writeFileSync(join(repo, 'web', '.env'), `VITE_FINGERPRINT_ENDPOINTS=https://${HOSTNAME}\n`)
  const gateway = await startGateway(subdomainAgent(join(repo, 'web', 'fingerprint.js')))
  t.after(() => gateway.close())

  const result = await runCli(['integrate'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url },
    respond: [
      { when: /Integrate Fingerprint into this repo/, send: 'y\n' },
      { when: /What's next\?/, send: `${DOWN}${DOWN}\n` }, // [server-side verification, custom subdomain, stop] → stop
    ],
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Protect against ad blockers/)
})
