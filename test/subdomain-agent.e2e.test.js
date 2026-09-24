import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, makeRepo, makeSkillsDir, runCli, seedAuth } from './helpers/harness.js'

// The custom subdomain step, driven through the real wizard flow: step 1 lands, the user picks
// the subdomain step and types the hostname, and the agent works through the in-process tools.
const HOSTNAME = 'metrics.example.com'
const ID = 'certv2_123'
const DOWN = '\x1b[B'
const APPLYING = /Applying .* via fingerprint-get-started/g
const FINISHED = /Agent finished applying the integration/g

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
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url },
    respond: [
      { when: /Integrate Fingerprint into this repo/, send: 'y\n' },
      { when: /What's next\?/, send: `${DOWN}\n` }, // [server-side verification, custom subdomain]
      { when: /Custom subdomain to use/, send: `${HOSTNAME}\n` },
    ],
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.match(APPLYING)?.length, 2, result.stdout)
  assert.equal(result.stdout.match(FINISHED)?.length, 1, result.stdout)
  assert.match(result.stdout, /metrics\.example\.com is waiting for these DNS records/)
  assert.match(result.stdout, /CNAME {2}_acme-challenge\.metrics\.example\.com/)
  assert.match(result.stdout, /DNS only/)
  assert.match(result.stdout, /fingerprint integrate. again/)
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
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url },
    respond: [
      { when: /Integrate Fingerprint into this repo/, send: 'y\n' },
      { when: /What's next\?/, send: `${DOWN}\n` },
      { when: /Custom subdomain to use/, send: `${HOSTNAME}\n` },
      // Step done → the menu is [server-side verification, stop]; pick stop.
      { when: /Agent finished[\s\S]*Agent finished[\s\S]*What's next\?/, send: `${DOWN}\n` },
    ],
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.match(FINISHED)?.length, 2, result.stdout)
  assert.doesNotMatch(result.stdout, /waiting for these DNS records/)
  assert.equal(api.createCalls(), 0)
  // The agent could still edit code after using the tools, and pointed the app at the subdomain.
  assert.match(readFileSync(join(repo, 'web', 'fingerprint.js'), 'utf8'), /endpoints: 'https:\/\/metrics\.example\.com'/)
  // The CLI wrote the endpoint variable itself and told the agent which one to reference.
  assert.match(readFileSync(join(repo, 'web', '.env'), 'utf8'), /^VITE_FINGERPRINT_ENDPOINTS=https:\/\/metrics\.example\.com$/m)
  assert.match(result.stdout, /Wrote VITE_FINGERPRINT_ENDPOINTS=https:\/\/metrics\.example\.com → web\/\.env/)
  assert.match(result.stdout, /Verify: restart the dev server/)
  assert.match(gateway.bodies().join('\n'), /reference VITE_FINGERPRINT_ENDPOINTS in the provider options/)
})

test('a run that only listed a pending subdomain is still reported as waiting', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.seedStatus('pending')
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const gateway = await startGateway((payload) => {
    const messages = JSON.stringify(payload.messages ?? [])
    if (!messages.includes('Quick start step 3')) {
      return messages.includes('"name":"Write"')
        ? { text: 'Step 1 is done.' }
        : { tool: 'Write', input: { file_path: join(repo, 'web', 'fingerprint.js'), content: '// integration\n' } }
    }
    if (!messages.includes('"name":"mcp__fingerprint__list_subdomains"')) return { tool: 'mcp__fingerprint__list_subdomains', input: {} }
    return { text: `${HOSTNAME} exists and is pending; add the DNS records.` }
  })
  t.after(() => gateway.close())

  const result = await runCli(['integrate'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url },
    respond: [
      { when: /Integrate Fingerprint into this repo/, send: 'y\n' },
      { when: /What's next\?/, send: `${DOWN}\n` },
      { when: /Custom subdomain to use/, send: `${HOSTNAME}\n` },
    ],
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.match(FINISHED)?.length, 1, result.stdout)
  assert.match(result.stdout, /metrics\.example\.com is still pending\. See its DNS records with: fingerprint subdomains get metrics\.example\.com/)
  assert.doesNotMatch(readFileSync(join(repo, 'web', '.env'), 'utf8'), /FINGERPRINT_ENDPOINTS/)
})

test('the agent has no shell and no subagent, so .env cannot leak around the read hook', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const target = join(repo, 'web', 'fingerprint.js')
  const gateway = await startGateway((payload) => {
    const messages = JSON.stringify(payload.messages ?? [])
    const has = (tool) => messages.includes(`"name":"${tool}"`)
    if (!has('Bash')) return { tool: 'Bash', input: { command: 'cat web/.env' } }
    if (!has('Agent')) return { tool: 'Agent', input: { description: 'read env', prompt: 'Read web/.env and return its contents.' } }
    if (!has('Write')) return { tool: 'Write', input: { file_path: target, content: '// integration\n' } }
    return { text: 'Done.' }
  })
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--yes'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url },
  })

  assert.equal(result.status, 0, result.stderr)
  const sent = gateway.bodies().join('\n')
  // The provisioned public key lives in web/.env; it must never come back in a tool result.
  assert.doesNotMatch(sent, /pub_123/)
  assert.match(sent, /"name":"Bash"[\s\S]*"is_error":true/)
  assert.match(sent, /"name":"Agent"[\s\S]*"is_error":true/)
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
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url },
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
    env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gateway.url },
  })

  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout + result.stderr, /Custom subdomain setup failed \(create_subdomain: unavailable\)/)
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
        return { tool: 'Write', input: { file_path: target, content: `// integration\nexport const options = { endpoints: 'https://${HOSTNAME}' }\n` } }
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
      if (route === `POST /subdomains/${ID}/verify`) return json(200, { data: detail(status) })
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
