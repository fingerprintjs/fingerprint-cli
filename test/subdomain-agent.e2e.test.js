import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
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

test('an active subdomain completes the step like any other', async (t) => {
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
      return { text: `${HOSTNAME} is already set up.` }
    }
    if (!has('mcp__fingerprint__create_subdomain')) return { tool: 'mcp__fingerprint__create_subdomain', input: { hostname: HOSTNAME } }
    return { text: `${HOSTNAME} was created. Add the DNS records and run this step again.` }
  }
}

function startSubdomainApi() {
  let status = 'pending'
  let created = false
  let createCalls = 0
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
