import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SubdomainsService } from '../dist/api/subdomains.js'
import { ManagementApiError, ManagementClient } from '../dist/api/management.js'
import { LOG_PATH } from '../dist/utils/log-file.js'

const item = (id, subdomain) => ({
  id,
  subdomain,
  status: 'pending',
  created_at: '2026-09-15T12:00:00.000Z',
  updated_at: '2026-09-15T12:00:00.000Z',
})

test('hostname lookup normalizes the name and follows every page', async () => {
  const paths = []
  const client = {
    async request(path) {
      paths.push(path)
      const cursor = new URL(path, 'http://localhost').searchParams.get('cursor')
      if (!cursor) {
        return {
          data: [item('certv2_first', 'other.example.com')],
          metadata: { pagination: { next_cursor: 'page-2' } },
        }
      }
      return {
        data: [item('certv2_match', 'Metrics.Example.com')],
        metadata: { pagination: { next_cursor: null } },
      }
    },
  }

  const result = await new SubdomainsService(client).findByHostname('  METRICS.example.COM. ')

  assert.equal(result.outcome, 'found')
  assert.equal(result.hostname, 'metrics.example.com')
  assert.equal(result.subdomain.id, 'certv2_match')
  assert.equal(paths.length, 2)
  assert.match(paths[0], /limit=100/)
  assert.match(paths[1], /cursor=page-2/)
})

test('hostname lookup reports zero and multiple matches explicitly', async () => {
  const service = new SubdomainsService({
    async request() {
      return {
        data: [item('certv2_one', 'metrics.example.com'), item('certv2_two', 'METRICS.EXAMPLE.COM')],
        metadata: { pagination: { next_cursor: null } },
      }
    },
  })

  const ambiguous = await service.findByHostname('metrics.example.com')
  assert.equal(ambiguous.outcome, 'ambiguous')
  assert.deepEqual(
    ambiguous.matches.map(({ id }) => id),
    ['certv2_one', 'certv2_two']
  )

  const missing = await service.findByHostname('missing.example.com')
  assert.deepEqual(missing, { outcome: 'not_found', hostname: 'missing.example.com' })
})

test('verify follows the POST response with an authoritative GET', async () => {
  const calls = []
  const fresh = { ...item('certv2_verify', 'metrics.example.com'), status: 'active' }
  const client = {
    async request(path, init = {}) {
      calls.push({ path, method: init.method ?? 'GET' })
      if (init.method === 'POST') return { data: item('certv2_verify', 'metrics.example.com') }
      return { data: fresh }
    },
  }

  const result = await new SubdomainsService(client).verify('certv2_verify')

  assert.equal(result, fresh)
  assert.deepEqual(calls, [
    { path: '/subdomains/certv2_verify/verify', method: 'POST' },
    { path: '/subdomains/certv2_verify', method: 'GET' },
  ])
})

test('Management API errors preserve details while redacting the host-side key', async () => {
  const originalFetch = globalThis.fetch
  const responses = [
    new Response(
      JSON.stringify({
        error: {
          code: 'validation.failed',
          message: 'Rejected mgmt_secret',
          violations: [{ property: 'subdomain', message: 'mgmt_secret is invalid' }],
        },
      }),
      { status: 422, headers: { 'content-type': 'application/json' } }
    ),
    new Response(
      JSON.stringify({
        error: { code: 'rate-limit.exceeded', message: 'You are sending too many requests' },
      }),
      { status: 429, headers: { 'retry-after': '60', 'content-type': 'application/json' } }
    ),
  ]
  globalThis.fetch = async () => responses.shift()

  try {
    const client = new ManagementClient({
      managementApiKey: 'mgmt_secret',
      managementApiUrl: 'https://management.example.test',
    })
    await assert.rejects(
      client.request('/subdomains', { method: 'POST' }),
      (error) => {
        assert.ok(error instanceof ManagementApiError)
        assert.equal(error.message, 'Rejected [REDACTED]')
        assert.deepEqual(error.violations, [{ property: 'subdomain', message: '[REDACTED] is invalid' }])
        return true
      }
    )
    await assert.rejects(
      client.request('/subdomains/test/verify', { method: 'POST' }),
      (error) => {
        assert.ok(error instanceof ManagementApiError)
        assert.equal(error.retryAfter, '60')
        return true
      }
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Management API network errors redact the host-side key from debug logs', async () => {
  const originalFetch = globalThis.fetch
  const key = `mgmt_network_${process.pid}_${Date.now()}`
  globalThis.fetch = async () => {
    throw new Error(`connection failed with ${key}`)
  }

  try {
    const client = new ManagementClient({
      managementApiKey: key,
      managementApiUrl: 'https://management.example.test',
    })
    await assert.rejects(client.request('/subdomains'), /Couldn’t reach the Management API/)

    const log = readFileSync(LOG_PATH, 'utf8')
    assert.doesNotMatch(log, new RegExp(key))
    assert.match(log, /connection failed with \[REDACTED\]/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
