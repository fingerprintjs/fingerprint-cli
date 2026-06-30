import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url))

// A fake mgmt-api: just enough of the endpoints the real flow hits, returning the {ok,data}
// envelope ApiClient expects. Lets the e2e drive real CLI commands over real HTTP with no network.
export function startMgmtApi() {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const path = req.url.split('?')[0]
      const ok = (data) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, data }))
      }
      const route = `${req.method} ${path}`
      if (route === 'POST /sso/auth') return ok({ sso: { isEnabled: false } })
      if (route === 'POST /login') return ok({ accessToken: 'acc_1', refreshToken: 'ref_1', context: { id: 'user_1' } })
      if (route === 'GET /subscriptions') return ok([{ id: 'sub_1', name: 'Test WS', regionCode: 'use1' }])
      if (route === 'GET /subscriptions/sub_1/tokens') return ok([{ type: 'browser', token: 'pub_123' }])
      if (route === 'POST /subscriptions/sub_1/tokens') return ok({ type: 'api', token: 'sec_456' })
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { message: `no route: ${route}` } }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

// Isolated $HOME so the CLI's auth state can't pick up a real `fingerprint login` on this machine.
export function makeHome() {
  return mkdtempSync(join(tmpdir(), 'fp-home-'))
}

// Pre-authenticate by writing the auth state the CLI would have saved after login (avoids needing a
// PTY to drive the interactive password prompt). apiUrl points the CLI at the fake mgmt-api.
export function seedAuth(home, apiUrl, extra = {}) {
  const dir = join(home, '.config', 'fingerprint')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({ accessToken: 'acc_1', refreshToken: 'ref_1', apiUrl, region: 'us', ...extra })
  )
}

// A fake LLM gateway speaking Anthropic's /v1/messages streaming protocol, scripted to make the
// agent perform exactly one Write (the "integration"), then end the turn. `writeTarget` is the
// absolute file the agent will create; the test points FINGERPRINT_GATEWAY_URL at this.
export function startGateway(writeTarget, writeContent) {
  let calls = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (!req.url.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{}')
      }
      calls++
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
      resolve({ url: `http://127.0.0.1:${port}`, calls: () => calls, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

// A local skills checkout (pointed at via FINGERPRINT_SKILLS_DIR) with the two skills React+Express
// resolves to. Empty `packages` so the post-agent installer is a no-op (no real npm install).
export function makeSkillsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'fp-skills-'))
  for (const [id, role] of [['fingerprint-react', 'frontend'], ['fingerprint-node', 'backend']]) {
    const s = join(dir, 'skills', id)
    mkdirSync(s, { recursive: true })
    writeFileSync(join(s, 'SKILL.md'), `# ${id}\nTest skill.\n`)
    writeFileSync(join(s, 'skill.json'), JSON.stringify({ id, role, packages: [] }))
  }
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
