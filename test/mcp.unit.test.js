import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withFingerprintServer } from '../dist/wizard/mcp.js'

test('the Fingerprint server is merged into a Cursor config without touching other keys', () => {
  assert.deepEqual(withFingerprintServer({}), { mcpServers: { fingerprint: { url: 'https://mcp.fpjs.io/mcp' } } })
  assert.deepEqual(withFingerprintServer({ theme: 'dark', mcpServers: { other: { command: 'x' } } }), {
    theme: 'dark',
    mcpServers: { other: { command: 'x' }, fingerprint: { url: 'https://mcp.fpjs.io/mcp' } },
  })
})

test('a Cursor config that already has the Fingerprint server is left alone', () => {
  assert.equal(withFingerprintServer({ mcpServers: { fingerprint: { url: 'https://custom.example/mcp' } } }), undefined)
})
