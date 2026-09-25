import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, makeRepo, makeSkillsDir, runCli, seedAuth } from './helpers/harness.js'

// The custom subdomain step, driven through the real wizard flow: step 1 lands, the user picks
// the subdomain step and types the hostname, and the agent works through the in-process tools.
const HOSTNAME = 'metrics.example.com'
const ID = 'certv2_123'
const DOWN = '\x1b[B'
const APPLYING = /Applying .* via fingerprint-get-started/g
const FINISHED = /Agent finished applying the integration/g
const DNS_MENU = /is waiting for its DNS records\. What's next\?/
const CREATING = /Setting up metrics\.example\.com/
const CONFIGURING = /Updating your app to use metrics\.example\.com/
const LATER = `${DOWN}${DOWN}\n`
const HOSTNAME_PROMPT = /Custom subdomain to use/

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
  assert.match(result.stdout, /CNAME {2}pending_validation\n.*Host {3}_acme-challenge\.metrics\.example\.com/)
  assert.match(result.stdout, /DNS only/)
  assert.match(result.stdout, /Finish later \(resume: fingerprint integrate --subdomain/)
  assert.equal(api.createCalls(), 1)
  const sent = gateway.bodies().join('\n')
  assert.match(sent, new RegExp(`The custom subdomain is ${HOSTNAME.replace('.', '\\.')}`))
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
      { when: /Custom subdomain to use/, send: `${HOSTNAME}\n` },
      // Step done → the menu is [server-side verification, stop]; pick stop.
      { when: /Wrote VITE_FINGERPRINT_ENDPOINTS[\s\S]*What's next\?/, send: `${DOWN}\n` },
    ],
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.match(FINISHED)?.length, 1, result.stdout) // step 1 only; the CLI closes the subdomain step
  assert.doesNotMatch(result.stdout, /waiting for these DNS records/)
  assert.equal(api.createCalls(), 0)
  // The agent could still edit code after using the tools, and pointed the app at the subdomain.
  assert.match(readFileSync(join(repo, 'web', 'fingerprint.js'), 'utf8'), /endpoints: import\.meta\.env\.VITE_FINGERPRINT_ENDPOINTS/)
  // The CLI wrote the endpoint variable itself and told the agent which one to reference.
  assert.match(readFileSync(join(repo, 'web', '.env'), 'utf8'), /^VITE_FINGERPRINT_ENDPOINTS=https:\/\/metrics\.example\.com$/m)
  assert.match(result.stdout, /Wrote VITE_FINGERPRINT_ENDPOINTS → web\/\.env/)
  assert.doesNotMatch(result.stdout, /pub_123/)
  assert.match(gateway.bodies().join('\n'), /reference VITE_FINGERPRINT_ENDPOINTS in the provider options/)
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
      { when: /Wrote VITE_FINGERPRINT_ENDPOINTS[\s\S]*What's next\?/, send: `${DOWN}\n` },
    ],
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(api.createCalls(), 1)
  assert.match(result.stdout, /metrics\.example\.com is active\./)
  assert.match(result.stdout, CONFIGURING)
  assert.equal(result.stdout.match(FINISHED)?.length, 1, result.stdout) // step 1 only; the CLI closes the subdomain step
  assert.match(readFileSync(join(repo, 'web', '.env'), 'utf8'), /VITE_FINGERPRINT_ENDPOINTS=https:\/\/metrics\.example\.com/)
  assert.match(readFileSync(join(repo, 'web', 'fingerprint.js'), 'utf8'), /endpoints: import\.meta\.env\.VITE_FINGERPRINT_ENDPOINTS/)
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
      { when: /Wrote VITE_FINGERPRINT_ENDPOINTS[\s\S]*What's next\?/, send: `${DOWN}\n` },
    ],
  })
  assert.equal(third.status, 0, third.stderr)
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

test('an agent run that never creates the subdomain is a failure, not a finished step', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(() => ({ text: 'All set.' })) // no tool calls at all
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--subdomain', HOSTNAME], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0' },
  })

  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout + result.stderr, /metrics\.example\.com was not created/)
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

test('a subdomain created while auditing still leaves the run waiting, not finished', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(createsDuringAuditAgent(join(repo, 'web', 'fingerprint.js')))
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--yes'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0' },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(api.createCalls(), 1)
  assert.match(result.stdout, /waiting for these DNS records/)
  assert.doesNotMatch(result.stdout, FINISHED)
})

test('a failed create ends the run as failed instead of finished', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.failCreate(503, 'general.unavailable')
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway(createsDuringAuditAgent(join(repo, 'web', 'fingerprint.js')))
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--yes'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url, FINGERPRINT_DNS_WAIT_MS: '0' },
  })

  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout + result.stderr, /Custom subdomain setup failed: Custom subdomain service is unavailable/)
  assert.doesNotMatch(result.stdout, FINISHED)
})

// The scripted agent: step 1 writes the integration file; the subdomain step lists, then creates
// the hostname or reads the existing one, and reports.
function subdomainAgent(target) {
  return (payload) => {
    const messages = JSON.stringify(payload.messages ?? [])
    const has = (tool) => messages.includes(`"name":"${tool}"`)
    if (!messages.includes('Quick start step 3')) {
      return has('Write') ? { text: 'Step 1 is done.' } : { tool: 'Write', input: { file_path: target, content: '// integration\n' } }
    }
    if (!has('mcp__fingerprint__list_subdomains')) return { tool: 'mcp__fingerprint__list_subdomains', input: {} }
    const listed = /"subdomains":\[\{[^\]]*"status":\\"(\w+)/.exec(messages) ? true : messages.includes(`\\"id\\":\\"${ID}\\"`)
    if (listed) {
      if (!has('mcp__fingerprint__get_subdomain')) return { tool: 'mcp__fingerprint__get_subdomain', input: { id: ID } }
      if (messages.includes('\\"status\\":\\"active\\"') && !has('Write')) {
        // The SDK requires a Read before overwriting an existing file.
        if (!has('Read')) return { tool: 'Read', input: { file_path: target } }
        return { tool: 'Write', input: { file_path: target, content: '// integration\nexport const options = { endpoints: import.meta.env.VITE_FINGERPRINT_ENDPOINTS }\n' } }
      }
      return { text: `${HOSTNAME} is already set up.` }
    }
    if (!has('mcp__fingerprint__create_subdomain')) return { tool: 'mcp__fingerprint__create_subdomain', input: { hostname: HOSTNAME } }
    return { text: `${HOSTNAME} was created. Add the DNS records and run this step again.` }
  }
}

// An agent that creates the subdomain during the first, audit-driven step instead of waiting for
// the user to pick that step.
function createsDuringAuditAgent(target) {
  return (payload) => {
    const messages = JSON.stringify(payload.messages ?? [])
    const has = (tool) => messages.includes(`"name":"${tool}"`)
    if (!has('mcp__fingerprint__create_subdomain')) return { tool: 'mcp__fingerprint__create_subdomain', input: { hostname: HOSTNAME } }
    if (!has('Write')) return { tool: 'Write', input: { file_path: target, content: '// integration\n' } }
    return { text: 'Done.' }
  }
}

function startSubdomainApi() {
  let status = 'pending'
  let created = false
  let createCalls = 0
  let createFailure
  let activateOnVerify = false
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
      if (route === 'GET /subdomains') return json(200, { data: created ? [summary(status)] : [], metadata: { pagination: { next_cursor: null } } })
      if (route === 'POST /subdomains') {
        createCalls += 1
        if (createFailure) return json(createFailure.code, { error: { code: createFailure.error, message: 'Service unavailable' } })
        created = true
        return json(200, { data: detail(status) })
      }
      if (route === `GET /subdomains/${ID}`) return json(200, { data: detail(status) })
      if (route === `POST /subdomains/${ID}/verify`) {
        const response = detail(status)
        if (activateOnVerify) status = 'active' // the refreshed GET after verify sees it
        return json(200, { data: response })
      }
      if (route.startsWith('POST /analytics/')) {
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
        failCreate(code, error) {
          createFailure = { code, error }
        },
        activateAfterVerify() {
          activateOnVerify = true
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
