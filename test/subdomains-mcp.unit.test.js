import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSubdomainsMcpServer, SUBDOMAIN_TOOL_NAMES } from '../dist/wizard/subdomains-mcp.js'

const item = {
  id: 'certv2_123',
  subdomain: 'metrics.example.com',
  status: 'pending',
  created_at: '2026-09-17T12:00:00.000Z',
  updated_at: '2026-09-17T12:00:00.000Z',
}

function detail(status, recordStatus = 'pending_validation') {
  return {
    ...item,
    status,
    webhook_url: null,
    webhook_secret: 'whsec_do_not_return',
    dns_records: {
      verification: { type: 'CNAME', host: '_acme-challenge.metrics.example.com', value: 'validation.example.com', status: recordStatus },
      routing: [{ type: 'A', host: 'metrics.example.com', value: '192.0.2.1', status: 'validated' }],
    },
  }
}

function makeService(overrides = {}) {
  const calls = []
  const service = {
    async list() {
      calls.push(['list'])
      return [item]
    },
    async get(id) {
      calls.push(['get', id])
      return detail('pending')
    },
    async create(hostname) {
      calls.push(['create', hostname])
      return detail('pending')
    },
    async verify(id) {
      calls.push(['verify', id])
      return detail('active', 'validated')
    },
    ...overrides,
  }
  return { calls, service }
}

function toolsByName(server) {
  return Object.fromEntries(server.tools.map((definition) => [definition.name, definition]))
}

test('exposes list, get, create and verify under the fingerprint server', () => {
  const server = createSubdomainsMcpServer(makeService().service)
  assert.deepEqual(Object.keys(toolsByName(server)), ['list_subdomains', 'get_subdomain', 'create_subdomain', 'verify_subdomain'])
  assert.deepEqual(SUBDOMAIN_TOOL_NAMES, [
    'mcp__fingerprint__list_subdomains',
    'mcp__fingerprint__get_subdomain',
    'mcp__fingerprint__create_subdomain',
    'mcp__fingerprint__verify_subdomain',
  ])
})

test('handlers call the service and return only public fields', async () => {
  const { calls, service } = makeService()
  const tools = toolsByName(createSubdomainsMcpServer(service))

  const listed = await tools.list_subdomains.handler({}, {})
  const created = await tools.create_subdomain.handler({ hostname: 'metrics.example.com' }, {})

  assert.deepEqual(calls, [['list'], ['create', 'metrics.example.com']])
  assert.deepEqual(listed.structuredContent, { subdomains: [item] })
  assert.equal(created.structuredContent.subdomain.status, 'pending')
  assert.equal(created.structuredContent.subdomain.dns_records.routing.length, 1)
  assert.doesNotMatch(JSON.stringify(created), /whsec_do_not_return|webhook/)
})

test('lastSeen follows the latest subdomain the agent read or changed', async () => {
  const server = createSubdomainsMcpServer(makeService().service)
  const tools = toolsByName(server)

  assert.equal(server.lastSeen(), undefined)
  await tools.list_subdomains.handler({}, {})
  assert.equal(server.lastSeen(), undefined, 'listing is an audit read, not a selection')

  await tools.get_subdomain.handler({ id: item.id }, {})
  assert.deepEqual(server.lastSeen(), {
    id: item.id,
    hostname: 'metrics.example.com',
    status: 'pending',
    pendingRecords: [{ type: 'CNAME', host: '_acme-challenge.metrics.example.com', value: 'validation.example.com', status: 'pending_validation' }],
    recordsKnown: true,
  })

  assert.equal(server.mutated(), false, 'reads are not mutations')

  await tools.verify_subdomain.handler({ id: item.id }, {})
  assert.equal(server.lastSeen().status, 'active')
  assert.deepEqual(server.lastSeen().pendingRecords, [])
  assert.equal(server.mutated(), true)
})

test('service errors come back as tool errors with the CLI error shape', async () => {
  const { service } = makeService({
    async create() {
      throw new Error('boom')
    },
  })
  const tools = toolsByName(createSubdomainsMcpServer(service))

  const result = await tools.create_subdomain.handler({ hostname: 'metrics.example.com' }, {})
  assert.equal(result.isError, true)
  assert.deepEqual(result.structuredContent, { error: { kind: 'api_error', message: 'boom' } })
})

test('lastFailure remembers a failed tool call until a subdomain is read or changed successfully', async () => {
  const { service } = makeService({
    async create() {
      throw new Error('boom')
    },
  })
  const server = createSubdomainsMcpServer(service)
  const tools = toolsByName(server)

  await tools.create_subdomain.handler({ hostname: 'metrics.example.com' }, {})
  assert.deepEqual(server.lastFailure(), { tool: 'create_subdomain', kind: 'api_error', message: 'boom' })
  assert.equal(server.mutated(), true)

  await tools.list_subdomains.handler({}, {})
  assert.ok(server.lastFailure(), 'a list does not clear the failure')

  await tools.get_subdomain.handler({ id: item.id }, {})
  assert.equal(server.lastFailure(), undefined)
})

test('with a known hostname, a list entry for it counts as seen, without records', async () => {
  const server = createSubdomainsMcpServer(makeService().service, ' Metrics.Example.com. ')
  const tools = toolsByName(server)

  await tools.list_subdomains.handler({}, {})
  assert.deepEqual(server.lastSeen(), {
    id: item.id,
    hostname: 'metrics.example.com',
    status: 'pending',
    pendingRecords: [],
    recordsKnown: false,
  })

  const other = createSubdomainsMcpServer(makeService().service, 'other.example.com')
  await toolsByName(other).list_subdomains.handler({}, {})
  assert.equal(other.lastSeen(), undefined)
})

test('with a known hostname, create refuses any other hostname without calling the API', async () => {
  const { calls, service } = makeService()
  const server = createSubdomainsMcpServer(service, 'metrics.example.com')
  const tools = toolsByName(server)

  const other = await tools.create_subdomain.handler({ hostname: 'other.example.com' }, {})
  assert.equal(other.isError, true)
  assert.equal(other.structuredContent.error.kind, 'invalid_subdomain')
  assert.deepEqual(calls, [])
  assert.equal(server.lastFailure().kind, 'invalid_subdomain')

  const same = await tools.create_subdomain.handler({ hostname: 'Metrics.Example.com.' }, {})
  assert.equal(same.isError, undefined)
  assert.deepEqual(calls, [['create', 'Metrics.Example.com.']])
})
