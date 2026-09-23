import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  makeHome,
  makeRepo,
  makeSkillsDir,
  runCli,
  seedAuth,
} from './helpers/harness.js'

const HOSTNAME = 'metrics.example.com'
const ID = 'certv2_123'
const CREATE_TOOL = 'mcp__fingerprint__create_subdomain'
const CONFIGURE_TOOL = 'mcp__fingerprint__configure_subdomain_endpoint'

test('embedded subdomain tools resume from pending to active without duplicating or exposing credentials', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  const temp = join(home, 'tmp')
  mkdirSync(temp)
  seedAuth(home, api.url, {
    accessToken: 'access_secret_1',
    refreshToken: 'refresh_secret_1',
    serverApiKey: 'server_secret_1',
    managementApiKey: 'management_secret_1',
  })
  const repo = makeRepo()
  const skillsDir = makeSkillsDir({}, { includeSubdomain: true })
  const target = join(repo, 'web', 'fingerprint-subdomain.js')
  const evilMarker = join(repo, 'project-mcp-ran')
  writeFileSync(
    join(repo, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        evil: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(evilMarker)}, 'ran')`] },
      },
    })
  )

  const pendingGateway = await startAgentGateway({ target, pending: true })
  t.after(() => pendingGateway.close())
  const first = await runCli(['--ci', 'integrate', '--yes', '--subdomain', HOSTNAME], {
    home,
    cwd: repo,
    env: {
      TMPDIR: temp,
      FINGERPRINT_SKILLS_DIR: skillsDir,
      FINGERPRINT_GATEWAY_URL: pendingGateway.url,
    },
  })
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /DNS records still waiting for validation/)
  assert.match(first.stdout, /CNAME _acme-challenge\.metrics\.example\.com.*validation\.example\.com/)
  assert.match(first.stdout, /A metrics\.example\.com.*192\.0\.2\.1/)
  assert.match(first.stdout, /A metrics\.example\.com.*192\.0\.2\.2/)
  assert.equal(api.createCalls(), 1)
  assert.doesNotMatch(readFileSync(join(repo, 'web', '.env'), 'utf8'), /FINGERPRINT_ENDPOINTS/)
  assert.equal(existsSync(target), false)

  api.setStatus('active')
  const activeGateway = await startAgentGateway({ target, pending: false })
  t.after(() => activeGateway.close())
  const second = await runCli(['--ci', 'integrate', '--yes', '--subdomain', HOSTNAME], {
    home,
    cwd: repo,
    env: {
      TMPDIR: temp,
      FINGERPRINT_SKILLS_DIR: skillsDir,
      FINGERPRINT_GATEWAY_URL: activeGateway.url,
    },
  })
  assert.equal(second.status, 0, second.stderr)
  assert.equal(api.createCalls(), 1, 'the second process must reuse the existing hostname')
  assert.equal(existsSync(target), true)
  const env = readFileSync(join(repo, 'web', '.env'), 'utf8')
  assert.match(env, /^VITE_FINGERPRINT_ENDPOINTS=https:\/\/metrics\.example\.com$/m)
  assert.equal(env.match(/^VITE_FINGERPRINT_ENDPOINTS=/gm)?.length, 1)
  assert.equal(existsSync(evilMarker), false, 'project MCP configuration must be ignored')

  const requests = [...pendingGateway.bodies(), ...activeGateway.bodies()]
  const requestText = requests.join('\n')
  const persistedText = readPersistedFiles(home, [join(home, '.config', 'fingerprint', 'auth.json')])
  assert.doesNotMatch(requestText, /must_not_reach_the_model/)
  for (const secret of ['access_secret_1', 'refresh_secret_1', 'server_secret_1', 'management_secret_1']) {
    assert.doesNotMatch(requestText, new RegExp(secret))
    assert.doesNotMatch(first.stdout + first.stderr + second.stdout + second.stderr, new RegExp(secret))
    assert.doesNotMatch(JSON.stringify(api.analyticsEvents()), new RegExp(secret))
    assert.doesNotMatch(persistedText, new RegExp(secret))
  }

  const advertisedTools = new Set(requests.flatMap((body) => (JSON.parse(body).tools ?? []).map((entry) => entry.name)))
  assert.ok(advertisedTools.has(CREATE_TOOL))
  assert.ok(advertisedTools.has(CONFIGURE_TOOL))
  assert.equal(advertisedTools.has('Bash'), false)
  assert.equal([...advertisedTools].some((name) => name.includes('evil')), false)
})

test('headless user questions exit with an actionable failure', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const skillsDir = makeSkillsDir({}, { includeSubdomain: true })
  const gateway = await startQuestionGateway()
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--yes'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gateway.url },
  })

  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /needs user action/)
})

test('headless timed-out recovery exits nonzero and explains delete/recreate', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.seedStatus('timed_out')
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const skillsDir = makeSkillsDir({}, { includeSubdomain: true })
  const gateway = await startCreateOnlyGateway()
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--yes', '--subdomain', HOSTNAME], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gateway.url },
  })

  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, new RegExp(`timed out.*Delete ${ID}.*create it again`, 's'))
  assert.equal(api.createCalls(), 0)
})

test('audit-selected subdomain skill locks generic edits before API activation', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const skillsDir = makeSkillsDir({}, { includeSubdomain: true })
  const target = join(repo, 'web', 'subdomain-bypass.js')
  const gateway = await startSubdomainBypassGateway(target)
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--yes'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gateway.url },
  })

  assert.equal(result.status, 1, result.stderr)
  assert.equal(existsSync(target), false)
  assert.match(result.stdout, /needs user action/)
})

test('--subdomain does not block an earlier integration step', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const skillsDir = makeSkillsDir({}, { includeSubdomain: true })
  const target = join(repo, 'web', 'fingerprint-integration.js')
  const gateway = await startGeneralIntegrationGateway(target)
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--yes', '--subdomain', HOSTNAME], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gateway.url },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(target, 'utf8'), '// base Fingerprint integration\n')
})

for (const status of [undefined, 'pending', 'active', 'timed_out', 'failed']) {
  test(`audit reads (${status ?? 'empty list'}) allow edits and package installation without invoking Skill`, async (t) => {
    const api = await startSubdomainApi()
    t.after(() => api.close())
    if (status) api.seedStatus(status)
    const home = makeHome()
    seedAuth(home, api.url)
    const repo = makeRepo()
    const skillsDir = makeSkillsDir({ 'fingerprint-react': ['@fingerprint/react'] }, { includeSubdomain: true })
    const target = join(repo, 'web', 'fingerprint-integration.js')
    const actions = [
      { tool: 'Read', input: { file_path: join(repo, '.claude', 'skills', 'fingerprint-react', 'SKILL.md') } },
      { tool: 'mcp__fingerprint__list_subdomains', input: {} },
      ...(status ? [{ tool: 'mcp__fingerprint__get_subdomain', input: { id: ID } }] : []),
    ]
    const gateway = await startGeneralIntegrationGateway(target, actions)
    t.after(() => gateway.close())
    const bin = join(home, 'bin')
    mkdirSync(bin)
    const installLog = join(home, 'install.json')
    writeFileSync(
      join(bin, 'npm'),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(installLog)}, JSON.stringify(process.argv.slice(2)))\n`,
      { mode: 0o755 }
    )

    const result = await runCli(['--ci', 'integrate', '--yes', '--subdomain', HOSTNAME], {
      home,
      cwd: repo,
      env: {
        FINGERPRINT_SKILLS_DIR: skillsDir,
        FINGERPRINT_GATEWAY_URL: gateway.url,
        PATH: `${bin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(target, 'utf8'), '// base Fingerprint integration\n')
    assert.deepEqual(JSON.parse(readFileSync(installLog, 'utf8')), ['install', '@fingerprint/react@latest'])
    assert.match(result.stdout, /Agent finished applying the integration/)
    assert.doesNotMatch(result.stdout, /Custom subdomain setup needs user action|Re-run the same fingerprint integrate/)
    assert.doesNotMatch(readFileSync(join(repo, 'web', '.env'), 'utf8'), /FINGERPRINT_ENDPOINTS/)
    assert.equal(api.createCalls(), 0)
  })
}

test('GET still reports waiting after the audit selects custom subdomain setup', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  api.seedStatus('pending')
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const skillsDir = makeSkillsDir({}, { includeSubdomain: true })
  const target = join(repo, 'web', 'subdomain-bypass.js')
  const gateway = await startGeneralIntegrationGateway(target, [
    { tool: 'Skill', input: { skill: 'fingerprint:fingerprint-proxy-integration' } },
    { tool: 'mcp__fingerprint__get_subdomain', input: { id: ID } },
  ])
  t.after(() => gateway.close())

  const result = await runCli(['--ci', 'integrate', '--yes', '--subdomain', HOSTNAME], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gateway.url },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /DNS records still waiting for validation/)
  assert.equal(existsSync(target), false)
  assert.doesNotMatch(readFileSync(join(repo, 'web', '.env'), 'utf8'), /FINGERPRINT_ENDPOINTS/)
})

test('general edits cannot set a custom endpoint before activation', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const skillsDir = makeSkillsDir({}, { includeSubdomain: true })
  const target = join(repo, 'web', 'endpoint-bypass.js')
  const gateway = await startGateway((payload) => {
    const messages = JSON.stringify(payload.messages ?? [])
    return messages.includes('"name":"Write"')
      ? { text: 'The endpoint edit was blocked.' }
      : { tool: 'Write', input: { file_path: target, content: `export const endpoints = 'https://${HOSTNAME}'\n` } }
  })
  t.after(() => gateway.close())

  await runCli(['--ci', 'integrate', '--yes'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gateway.url },
  })

  assert.equal(existsSync(target), false)
  assert.match(gateway.bodies().join('\n'), /Custom subdomain endpoint changes require an active API status first/)
})

test('choosing a non-subdomain proxy keeps the unified skill editable', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url)
  const repo = makeRepo()
  const skillsDir = makeSkillsDir({}, { includeSubdomain: true })
  const target = join(repo, 'web', 'proxy-integration.js')
  const gateway = await startProxyChoiceGateway(target)
  t.after(() => gateway.close())

  const result = await runCli(['integrate', '--yes'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gateway.url },
    respond: [{ when: /How do you want to protect the integration\?/, send: '\u001b[B\n' }],
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    readFileSync(target, 'utf8'),
    "export const options = { endpoints: 'https://proxy.example.com' }\n"
  )
})

test('agent cannot read the host-side authentication store', async (t) => {
  const api = await startSubdomainApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url, {
    accessToken: 'access_never_in_body',
    refreshToken: 'refresh_never_in_body',
    serverApiKey: 'server_never_in_body',
    managementApiKey: 'management_never_in_body',
  })
  const repo = makeRepo()
  const skillsDir = makeSkillsDir({}, { includeSubdomain: true })
  const authFile = join(home, '.config', 'fingerprint', 'auth.json')
  const gateway = await startReadAttemptGateway(authFile)
  t.after(() => gateway.close())

  const result = await runCli(['integrate', '--yes'], {
    home,
    cwd: repo,
    env: { FINGERPRINT_SKILLS_DIR: skillsDir, FINGERPRINT_GATEWAY_URL: gateway.url },
  })
  assert.equal(result.status, 0, result.stderr)
  const sent = gateway.bodies().join('\n')
  for (const secret of [
    'access_never_in_body',
    'refresh_never_in_body',
    'server_never_in_body',
    'management_never_in_body',
  ]) {
    assert.doesNotMatch(sent, new RegExp(secret))
  }
  assert.match(sent, /authentication store|restricted to the current project/)
})

function startSubdomainApi() {
  let status = 'pending'
  let created = false
  let createCalls = 0
  const analyticsEvents = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const path = req.url.split('?')[0]
      const route = `${req.method} ${path}`
      const json = (code, value) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }

      if (route === 'GET /api-keys') return json(200, { data: [{ id: 'pub', type: 'public', status: 'enabled', token: 'pub_123' }] })
      if (route === 'GET /subdomains') {
        return json(200, { data: created ? [summary(status)] : [], metadata: { pagination: { next_cursor: null } } })
      }
      if (route === 'POST /subdomains') {
        createCalls += 1
        created = true
        status = 'pending'
        return json(200, { data: detail(status) })
      }
      if (route === `GET /subdomains/${ID}`) return json(200, { data: detail(status) })
      if (route === `POST /subdomains/${ID}/verify`) return json(200, { data: detail(status) })
      if (route === 'POST /analytics/events' || route === 'POST /analytics/anonymous-events') {
        analyticsEvents.push(JSON.parse(body))
        res.writeHead(202)
        return res.end()
      }
      return json(404, { error: { message: `no route: ${route}` } })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        setStatus(next) {
          status = next
        },
        seedStatus(next) {
          created = true
          status = next
        },
        createCalls: () => createCalls,
        analyticsEvents: () => analyticsEvents,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

function summary(status) {
  return {
    id: ID,
    subdomain: HOSTNAME,
    status,
    created_at: '2026-09-17T12:00:00.000Z',
    updated_at: '2026-09-17T12:00:00.000Z',
  }
}

function detail(status) {
  const recordStatus = status === 'active' ? 'validated' : 'pending_validation'
  return {
    ...summary(status),
    webhook_url: null,
    webhook_secret: 'must_not_reach_the_model',
    dns_records: {
      verification: {
        type: 'CNAME',
        host: `_acme-challenge.${HOSTNAME}`,
        value: 'validation.example.com',
        status: recordStatus,
      },
      routing: [
        { type: 'A', host: HOSTNAME, value: '192.0.2.1', status: recordStatus },
        { type: 'A', host: HOSTNAME, value: '192.0.2.2', status: recordStatus },
      ],
    },
  }
}

function startAgentGateway({ target, pending }) {
  return startGateway((payload) => {
    const messages = JSON.stringify(payload.messages ?? [])
    const toolNames = new Set((payload.tools ?? []).map((entry) => entry.name))
    if (!toolNames.has(CREATE_TOOL)) return { text: 'Done.' }
    if (!messages.includes('"type":"tool_result"')) {
      return { tool: CREATE_TOOL, input: { hostname: HOSTNAME } }
    }
    if (pending && !messages.includes('"name":"Write"')) {
      return { tool: 'Write', input: { file_path: target, content: `endpoints: 'https://${HOSTNAME}'\n` } }
    }
    if (pending) return { text: 'The subdomain is pending. Add the DNS records shown above and rerun the command later.' }
    if (!messages.includes(`"name":"${CONFIGURE_TOOL}"`)) {
      return { tool: CONFIGURE_TOOL, input: { id: ID } }
    }
    if (!messages.includes('"name":"Write"')) {
      return { tool: 'Write', input: { file_path: target, content: '// endpoint configured\n' } }
    }
    return { text: 'The active custom subdomain is configured.' }
  })
}

function startReadAttemptGateway(authFile) {
  return startGateway((payload) => {
    const messages = JSON.stringify(payload.messages ?? [])
    if (!messages.includes('"type":"tool_result"')) {
      return { tool: 'Read', input: { file_path: authFile } }
    }
    return { text: 'The protected file was not read.' }
  })
}

function startQuestionGateway() {
  return startGateway((payload) => {
    const messages = JSON.stringify(payload.messages ?? [])
    if (!messages.includes('"type":"tool_result"')) {
      return {
        tool: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which subdomain should be used?',
              header: 'Subdomain',
              options: [
                { label: 'metrics.example.com', description: 'Use the existing subdomain.' },
                { label: 'api.example.com', description: 'Use another subdomain.' },
              ],
              multiSelect: false,
            },
          ],
        },
      }
    }
    return { text: 'User input is required.' }
  })
}

function startCreateOnlyGateway() {
  return startGateway((payload) => {
    const messages = JSON.stringify(payload.messages ?? [])
    if (!messages.includes(`"name":"${CREATE_TOOL}"`)) {
      return { tool: CREATE_TOOL, input: { hostname: HOSTNAME } }
    }
    return { text: 'The timed-out subdomain needs user action.' }
  })
}

function startSubdomainBypassGateway(target) {
  return startGateway((payload) => {
    const messages = JSON.stringify(payload.messages ?? [])
    if (!messages.includes('"name":"Skill"')) {
      return {
        tool: 'Skill',
        input: { skill: 'fingerprint:fingerprint-proxy-integration' },
      }
    }
    if (!messages.includes('"name":"Write"')) {
      return {
        tool: 'Write',
        input: { file_path: target, content: "const apiUrl = 'https://metrics.example.com'\n" },
      }
    }
    return { text: 'The edit was blocked.' }
  })
}

function startGeneralIntegrationGateway(target, actions = []) {
  return startGateway((payload) => {
    const messages = JSON.stringify(payload.messages ?? [])
    for (const action of actions) {
      if (!messages.includes(`"name":"${action.tool}"`)) return action
    }
    if (!messages.includes('"name":"Write"')) {
      return {
        tool: 'Write',
        input: { file_path: target, content: '// base Fingerprint integration\n' },
      }
    }
    return { text: 'The base integration is complete.' }
  })
}

function startProxyChoiceGateway(target) {
  return startGateway((payload) => {
    const messages = JSON.stringify(payload.messages ?? [])
    if (!messages.includes('"name":"Skill"')) {
      return { tool: 'Skill', input: { skill: 'fingerprint:fingerprint-proxy-integration' } }
    }
    if (!messages.includes('"name":"AskUserQuestion"')) {
      return {
        tool: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'How do you want to protect the integration?',
              header: 'Approach',
              options: [
                { label: 'Custom subdomain', description: 'Use the managed subdomain API.' },
                { label: 'Proxy integration', description: 'Configure an existing edge proxy.' },
              ],
              multiSelect: false,
            },
          ],
        },
      }
    }
    if (!messages.includes('"name":"Write"')) {
      return {
        tool: 'Write',
        input: {
          file_path: target,
          content: "export const options = { endpoints: 'https://proxy.example.com' }\n",
        },
      }
    }
    return { text: 'The proxy integration is configured.' }
  })
}

function readPersistedFiles(root, excluded = []) {
  const excludedPaths = new Set(excluded)
  const contents = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (excludedPaths.has(path)) continue
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) contents.push(readFileSync(path, 'utf8'))
    }
  }
  visit(root)
  return contents.join('\n')
}

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
        message: {
          id: `m_${bodies.length}`,
          type: 'message',
          role: 'assistant',
          model: 'test',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })
      if (action.tool) {
        event('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: `tool_${bodies.length}`, name: action.tool, input: {} },
        })
        event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(action.input) },
        })
        event('content_block_stop', { type: 'content_block_stop', index: 0 })
        event('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 1 },
        })
      } else {
        event('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })
        event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: action.text },
        })
        event('content_block_stop', { type: 'content_block_stop', index: 0 })
        event('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        })
      }
      event('message_stop', { type: 'message_stop' })
      res.end()
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        bodies: () => bodies,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}
