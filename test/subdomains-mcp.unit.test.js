import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ManagementApiError } from '../dist/api/management.js'
import { NotAuthenticatedError } from '../dist/utils/session.js'
import {
  createSubdomainsMcpServer,
  createSubdomainsTools,
  FINGERPRINT_MCP_SERVER_NAME,
  SUBDOMAIN_TOOL_NAMES,
} from '../dist/wizard/subdomains-mcp.js'

const item = {
  id: 'certv2_123',
  subdomain: 'metrics.example.com',
  status: 'pending',
  created_at: '2026-09-17T12:00:00.000Z',
  updated_at: '2026-09-17T12:00:00.000Z',
  internal_list_field: 'do-not-return',
}

const subdomain = {
  ...item,
  webhook_url: 'https://hooks.example.com/private',
  internal_detail_field: 'do-not-return',
  dns_records: {
    verification: {
      type: 'CNAME',
      host: '_acme-challenge.metrics.example.com',
      value: 'validation.example.com',
      status: 'pending_validation',
      internal_record_field: 'do-not-return',
    },
    routing: [
      {
        type: 'A',
        host: 'metrics.example.com',
        value: '192.0.2.1',
        status: 'validated',
        internal_record_field: 'do-not-return',
      },
    ],
    caa: {
      type: 'CAA',
      host: 'metrics.example.com',
      value: '0 issue "pki.goog"',
      status: 'validated',
      internal_record_field: 'do-not-return',
    },
  },
}

function makeService() {
  const calls = []
  return {
    calls,
    service: {
      async create(hostname) {
        calls.push(['create', hostname])
        return { ...subdomain, webhook_secret: 'whsec_do_not_return' }
      },
      async list() {
        calls.push(['list'])
        return [item]
      },
      async get(id) {
        calls.push(['get', id])
        return subdomain
      },
      async verify(id) {
        calls.push(['verify', id])
        return { ...subdomain, status: 'active' }
      },
      async delete(id) {
        calls.push(['delete', id])
      },
    },
  }
}

function toolsByName(service) {
  return Object.fromEntries(createSubdomainsTools(service).map((definition) => [definition.name, definition]))
}

test('registers the five subdomain tools with honest annotations', () => {
  const { service } = makeService()
  const tools = toolsByName(service)

  assert.deepEqual(Object.keys(tools), Object.values(SUBDOMAIN_TOOL_NAMES))
  assert.deepEqual(tools.list_subdomains.annotations, {
    title: 'List Subdomains',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  })
  assert.deepEqual(tools.get_subdomain.annotations, {
    title: 'Get Subdomain',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  })
  assert.deepEqual(tools.create_subdomain.annotations, {
    title: 'Create Subdomain',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  })
  assert.deepEqual(tools.verify_subdomain.annotations, {
    title: 'Verify Subdomain',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  })
  assert.deepEqual(tools.delete_subdomain.annotations, {
    title: 'Delete Subdomain',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  })

  const server = createSubdomainsMcpServer(service)
  assert.equal(server.type, 'sdk')
  assert.equal(server.name, FINGERPRINT_MCP_SERVER_NAME)
})

test('tool handlers call the injected service and return structured JSON', async () => {
  const { service, calls } = makeService()
  const tools = toolsByName(service)

  const created = await tools.create_subdomain.handler({ hostname: 'metrics.example.com' }, {})
  const listed = await tools.list_subdomains.handler({}, {})
  const fetched = await tools.get_subdomain.handler({ id: item.id }, {})
  const verified = await tools.verify_subdomain.handler({ id: item.id }, {})
  const deleted = await tools.delete_subdomain.handler({ id: item.id }, {})

  assert.equal(created.structuredContent.subdomain.id, item.id)
  assert.deepEqual(listed.structuredContent, {
    subdomains: [
      {
        id: item.id,
        subdomain: item.subdomain,
        status: item.status,
        created_at: item.created_at,
        updated_at: item.updated_at,
      },
    ],
  })
  assert.equal(fetched.structuredContent.subdomain.subdomain, item.subdomain)
  assert.equal(verified.structuredContent.subdomain.status, 'active')
  assert.deepEqual(deleted.structuredContent, { id: item.id, deleted: true })
  for (const result of [created, listed, fetched, verified, deleted]) {
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent)
    assert.doesNotMatch(result.content[0].text, /whsec_|hooks\.example|do-not-return/)
  }
  assert.deepEqual(Object.keys(created.structuredContent.subdomain), [
    'id',
    'subdomain',
    'status',
    'created_at',
    'updated_at',
    'dns_records',
  ])
  assert.deepEqual(Object.keys(created.structuredContent.subdomain.dns_records.verification), [
    'type',
    'host',
    'value',
    'status',
  ])
  assert.deepEqual(Object.keys(created.structuredContent.subdomain.dns_records.routing[0]), [
    'type',
    'host',
    'value',
    'status',
  ])
  assert.deepEqual(Object.keys(created.structuredContent.subdomain.dns_records.caa), [
    'type',
    'host',
    'value',
    'status',
  ])
  assert.deepEqual(calls, [
    ['create', 'metrics.example.com'],
    ['list'],
    ['get', item.id],
    ['verify', item.id],
    ['delete', item.id],
  ])
})

test('tool errors preserve actionable API details in a model-safe result', async () => {
  const service = makeService().service
  service.verify = async () => {
    throw new ManagementApiError(
      'You are sending too many requests',
      429,
      'rate-limit.exceeded',
      undefined,
      '60'
    )
  }
  const tools = toolsByName(service)

  const result = await tools.verify_subdomain.handler({ id: item.id }, {})

  assert.equal(result.isError, true)
  assert.deepEqual(result.structuredContent, {
    error: {
      kind: 'rate_limited',
      message: 'You are sending too many requests',
      status: 429,
      code: 'rate-limit.exceeded',
      retry_after: '60',
    },
  })
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent)
})

for (const { error, expected } of [
  {
    error: new NotAuthenticatedError(),
    expected: { kind: 'not_authenticated', message: 'Not logged in. Run: fingerprint login' },
  },
  {
    error: new ManagementApiError('Unauthorized.', 401, 'token.invalid'),
    expected: {
      kind: 'not_authenticated',
      message: 'Unauthorized. Run: fingerprint login',
      status: 401,
      code: 'token.invalid',
    },
  },
  {
    error: new ManagementApiError('Service unavailable. Try again later.', 503, 'general.unavailable', undefined, '60'),
    expected: {
      kind: 'unavailable',
      message:
        'Custom subdomain service is unavailable. This may be temporary, or the feature may be disabled. ' +
        'Check availability with Fingerprint support before retrying.',
      status: 503,
      code: 'general.unavailable',
      retry_after: '60',
    },
  },
]) {
  test(`tool errors return ${expected.kind} for ${error.status ?? 'missing auth'}`, async () => {
    const service = makeService().service
    service.list = async () => {
      throw error
    }

    const result = await toolsByName(service).list_subdomains.handler({}, {})

    assert.equal(result.isError, true)
    assert.deepEqual(result.structuredContent, { error: expected })
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent)
  })
}
