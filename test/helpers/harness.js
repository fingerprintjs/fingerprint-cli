import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url))

// A fake PUBLIC Management API: just the endpoints the post-login flow hits (list/create API keys),
// returning the `{ data }` envelope the ManagementClient expects. Lets the e2e drive real CLI
// commands over real HTTP with no network. The CLI authenticates with its Management API key.
export function startManagementApi() {
  const analyticsEvents = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const path = req.url.split('?')[0]
      const ok = (data) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data }))
      }
      const route = `${req.method} ${path}`
      // GET /api-keys?type=public&... → the workspace's public (browser) key.
      if (route === 'GET /api-keys') return ok([{ id: 'key_pub', type: 'public', status: 'enabled', token: 'pub_123' }])
      // POST /api-keys → mint a secret key (value only returned here).
      if (route === 'POST /api-keys') return ok({ id: 'key_sec', type: 'secret', status: 'enabled', token: 'sec_456' })
      // POST /analytics/events → the relay that forwards to Amplitude server-side.
      if (route === 'POST /analytics/events') {
        let parsed
        try {
          parsed = JSON.parse(body)
        } catch {
          // Surface a malformed payload as a 400 the test can assert on, rather than throwing in
          // the request handler and taking down the run with an unrelated stack trace.
          res.writeHead(400, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: { message: `invalid JSON: ${body}` } }))
        }
        analyticsEvents.push({ body: parsed, authorization: req.headers.authorization })
        res.writeHead(202)
        return res.end()
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `no route: ${route}` } }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        analyticsEvents: () => analyticsEvents,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

// Isolated $HOME so the CLI's auth state can't pick up a real `fingerprint login` on this machine.
export function makeHome() {
  return mkdtempSync(join(tmpdir(), 'fp-home-'))
}

// Pre-authenticate by writing the auth state the CLI would have saved after browser login (avoids
// needing to drive the interactive browser flow). `managementApiUrl` points the CLI at the fake
// Management API above; the workspace + region are fixed at login time.
export function seedAuth(home, managementApiUrl, extra = {}) {
  const dir = join(home, '.config', 'fingerprint')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({
      accessToken: 'tok_1',
      serverApiKey: 'srv_1',
      managementApiKey: 'mgmt_key_1',
      workspaceId: 'sub_1',
      region: 'us',
      managementApiUrl,
      ...extra,
    })
  )
}

// Read the auth state back, to assert on what a run persisted.
export function readAuth(home) {
  return JSON.parse(readFileSync(join(home, '.config', 'fingerprint', 'auth.json'), 'utf8'))
}

// An unsigned JWT carrying `claims`. The CLI only ever decodes the payload (the gateway is what
// verifies signatures), so a real key isn't needed to exercise the expiry logic.
export function fakeJwt(claims) {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `header.${body}.signature`
}

export const expiredJwt = () => fakeJwt({ sub: 'srv_1-mgmt_key_1-us', exp: Math.floor(Date.now() / 1000) - 60 })
export const liveJwt = () => fakeJwt({ sub: 'srv_1-mgmt_key_1-us', exp: Math.floor(Date.now() / 1000) + 3600 })

// A fake OAuth authorization server: discovery + the refresh_token grant, which is all the CLI's
// token refresh touches. `rt_dead` is rejected the way a revoked/expired refresh token would be.
// `deadTokenEndpoint` advertises a closed port as the token endpoint, so discovery succeeds and the
// grant that follows fails at the network level (offline / DNS / proxy), which is a different code
// path from any HTTP status.
export function startAuthServer({ deadTokenEndpoint = false } = {}) {
  const grants = []
  let base = ''
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const path = req.url.split('?')[0]
      const json = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(data))
      }
      if (path === '/.well-known/oauth-authorization-server') {
        // Port 1 is reserved and never listening, so a POST there rejects instead of answering.
        const tokenEndpoint = deadTokenEndpoint ? 'http://127.0.0.1:1/token' : `${base}/token`
        return json(200, { authorization_endpoint: `${base}/authorize`, token_endpoint: tokenEndpoint })
      }
      if (path === '/token') {
        const params = Object.fromEntries(new URLSearchParams(body))
        grants.push(params)
        if (params.refresh_token === 'rt_dead') return json(400, { error: 'invalid_grant' })
        // Rotate the refresh token on every use, like the real server does.
        return json(200, { access_token: liveJwt(), refresh_token: 'rt_rotated', expires_in: 3600 })
      }
      json(404, { error: `no route: ${path}` })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve({ url: base, grants: () => grants, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

// A fake LLM gateway speaking Anthropic's /v1/messages streaming protocol, scripted to make the
// agent perform exactly one Write (the "integration"), then end the turn. `writeTarget` is the
// absolute file the agent will create; the test points FINGERPRINT_GATEWAY_URL at this.
export function startGateway(writeTarget, writeContent) {
  let calls = 0
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (!req.url.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{}')
      }
      calls++
      requests.push(body)
      // Drive off conversation content, not a call counter: the real run may make preamble calls, so
      // emit the Write on any turn that has no tool_result yet, then end once the write came back.
      const alreadyWrote = body.includes('tool_result')
      if (process.env.FP_GW_DEBUG) console.error(`[gw] call ${calls} alreadyWrote=${alreadyWrote}`)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
      ev('message_start', {
        type: 'message_start',
        message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      })
      if (!alreadyWrote) {
        // Tell the agent to Write the integration file.
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Write', input: {} } })
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: writeTarget, content: writeContent }) } })
        ev('content_block_stop', { type: 'content_block_stop', index: 0 })
        ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } })
      } else {
        // After the tool_result: summarize and finish.
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Integrated Fingerprint.' } })
        ev('content_block_stop', { type: 'content_block_stop', index: 0 })
        ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
      }
      ev('message_stop', { type: 'message_stop' })
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls: () => calls,
        requests: () => requests,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

// A local skills checkout (pointed at via FINGERPRINT_SKILLS_DIR) with the two skills React+Express
// resolves to. Empty `packages` so the post-agent installer is a no-op (no real npm install).
export function makeSkillsDir({ reactPackages = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fp-skills-'))
  for (const [id, role] of [['fingerprint-react', 'frontend'], ['fingerprint-node', 'backend']]) {
    const s = join(dir, 'skills', id)
    mkdirSync(s, { recursive: true })
    writeFileSync(join(s, 'SKILL.md'), `# ${id}\nTest skill.\n`)
    const packages = id === 'fingerprint-react' ? reactPackages : []
    writeFileSync(join(s, 'skill.json'), JSON.stringify({ id, role, packages }))
  }
  return dir
}

// A frontend-only Vite/React fixture at the workspace root, managed by pnpm, with a Cloudflare
// config that already belongs to the frontend deployment. The wrangler file is the trap: a
// frontend-only run has to leave it alone instead of treating it as a backend to extend.
export function makeFrontendOnlyPnpmRepo() {
  const root = mkdtempSync(join(tmpdir(), 'fp-react-pnpm-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '^19' } }))
  writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - '.'\n")
  writeFileSync(join(root, 'wrangler.jsonc'), '{\n  "name": "frontend-only"\n}\n')
  return root
}

// Deterministically reproduce pnpm refusing an install because a dependency's build script was
// not approved, without executing any package scripts or reaching the registry.
export function makePnpmIgnoredBuildsBin() {
  const dir = mkdtempSync(join(tmpdir(), 'fp-bin-'))
  const bin = join(dir, 'pnpm')
  writeFileSync(bin, '#!/bin/sh\necho "ERR_PNPM_IGNORED_BUILDS Build scripts were ignored" >&2\nexit 1\n')
  chmodSync(bin, 0o755)
  return dir
}

// A React frontend + Express backend monorepo fixture.
export function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'fp-repo-'))
  mkdirSync(join(root, 'web'))
  mkdirSync(join(root, 'api'))
  writeFileSync(join(root, 'web', 'package.json'), JSON.stringify({ name: 'web', dependencies: { react: '^18' } }))
  writeFileSync(join(root, 'api', 'package.json'), JSON.stringify({ name: 'api', dependencies: { express: '^4' } }))
  return root
}

// Async (not spawnSync): the fake servers run in this same process, so the event loop must stay
// free to answer the child's HTTP requests while it runs — spawnSync would deadlock.
export function runCli(args, { home, cwd, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, HOME: home ?? makeHome(), CI: '', ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout, stderr })
    })
    child.stdin.end('')
  })
}
