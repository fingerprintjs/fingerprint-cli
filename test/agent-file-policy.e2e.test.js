import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { makeHome, makeRepo, makeSkillsDir, runCli, seedAuth, startManagementApi } from './helpers/harness.js'

test('agent cannot read the host-side authentication store', async (t) => {
  const api = await startManagementApi()
  t.after(() => api.close())
  const home = makeHome()
  seedAuth(home, api.url, {
    accessToken: 'access_never_in_body',
    refreshToken: 'refresh_never_in_body',
    serverApiKey: 'server_never_in_body',
    managementApiKey: 'management_never_in_body',
  })
  const repo = makeRepo()
  const skillsDir = makeSkillsDir()
  const authFile = join(home, '.config', 'fingerprint', 'auth.json')
  const gateway = await startGateway((payload) => {
    const messages = JSON.stringify(payload.messages ?? [])
    if (!messages.includes('"type":"tool_result"')) {
      return { tool: 'Read', input: { file_path: authFile } }
    }
    return { text: 'The protected file was not read.' }
  })
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
