import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONFIGURE_SUBDOMAIN_ENDPOINT_TOOL,
  createSubdomainRuntime,
} from '../dist/wizard/subdomain-runtime.js'
import { SUBDOMAIN_TOOL_NAMES } from '../dist/wizard/subdomains-mcp.js'
import { ManagementApiError } from '../dist/api/management.js'
import { NotAuthenticatedError } from '../dist/utils/session.js'

const CREATED_AT = '2026-09-17T12:00:00.000Z'

function makeSubdomain(status = 'pending', overrides = {}) {
  return {
    id: 'certv2_123',
    subdomain: 'metrics.example.com',
    status,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    webhook_url: null,
    dns_records: {
      verification: {
        type: 'CNAME',
        host: '_acme-challenge.metrics.example.com',
        value: 'validation.example.com',
        status: status === 'active' ? 'validated' : 'pending_validation',
      },
      routing: [
        {
          type: 'A',
          host: 'metrics.example.com',
          value: '192.0.2.1',
          status: status === 'active' ? 'validated' : 'pending_validation',
        },
      ],
    },
    ...overrides,
  }
}

function makeService(initial = [], options = {}) {
  const records = [...initial]
  const calls = []
  let nextId = 1

  return {
    calls,
    records,
    service: {
      async findByHostname(hostname) {
        calls.push(['findByHostname', hostname])
        const matches = records.filter((item) => item.subdomain.toLowerCase() === hostname)
        if (matches.length === 0) return { outcome: 'not_found', hostname }
        if (matches.length === 1) return { outcome: 'found', hostname, subdomain: matches[0] }
        return { outcome: 'ambiguous', hostname, matches }
      },
      async create(hostname) {
        calls.push(['create', hostname])
        const created = makeSubdomain(options.createStatus ?? 'pending', {
          id: `certv2_created_${nextId++}`,
          subdomain: hostname,
          webhook_secret: 'never-return-this',
        })
        records.push(created)
        return created
      },
      async list() {
        calls.push(['list'])
        return records
      },
      async get(id) {
        calls.push(['get', id])
        const found = records.find((item) => item.id === id)
        if (!found) throw new Error(`Unknown subdomain: ${id}`)
        return found
      },
      async verify(id) {
        calls.push(['verify', id])
        const index = records.findIndex((item) => item.id === id)
        if (index < 0) throw new Error(`Unknown subdomain: ${id}`)
        records[index] = makeSubdomain(options.verifyStatus ?? 'active', records[index])
        records[index].status = options.verifyStatus ?? 'active'
        return records[index]
      },
      async delete(id) {
        calls.push(['delete', id])
        const index = records.findIndex((item) => item.id === id)
        if (index >= 0) records.splice(index, 1)
      },
    },
  }
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'fp-subdomain-runtime-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '^15' } }))
  return root
}

async function invoke(runtime, name, input = {}) {
  const registered = runtime.server.instance._registeredTools[name]
  assert.ok(registered, `Expected MCP tool ${name}`)
  return registered.handler(input, {})
}

test('create preflights the hostname and a second call reuses the existing resource', async () => {
  const root = makeRepo()
  const fake = makeService()
  const prompts = []
  const runtime = createSubdomainRuntime({
    root,
    service: fake.service,
    confirm: async ({ message }) => {
      prompts.push(message)
      return true
    },
  })

  const first = await invoke(runtime, SUBDOMAIN_TOOL_NAMES.create, {
    hostname: 'Metrics.Example.com.',
  })
  const second = await invoke(runtime, SUBDOMAIN_TOOL_NAMES.create, {
    hostname: 'metrics.example.com',
  })

  assert.equal(first.structuredContent.subdomain.status, 'pending')
  assert.equal(second.structuredContent.subdomain.id, first.structuredContent.subdomain.id)
  assert.equal(runtime.state.outcome, 'waiting')
  assert.deepEqual(prompts, ['Create the immutable custom subdomain metrics.example.com?'])
  assert.equal(fake.calls.filter(([operation]) => operation === 'create').length, 1)
  assert.deepEqual(fake.calls, [
    ['findByHostname', 'metrics.example.com'],
    ['create', 'metrics.example.com'],
  ])
})

test('create reuses one match and reports multiple matches deterministically', async () => {
  const existing = makeSubdomain('active')
  const one = makeService([existing])
  const oneRuntime = createSubdomainRuntime({
    root: makeRepo(),
    service: one.service,
    confirm: async () => {
      throw new Error('Existing resources do not require confirmation')
    },
  })

  const reused = await invoke(oneRuntime, SUBDOMAIN_TOOL_NAMES.create, {
    hostname: existing.subdomain,
  })

  assert.equal(reused.structuredContent.subdomain.id, existing.id)
  assert.equal(oneRuntime.state.outcome, 'active')
  assert.equal(one.calls.some(([operation]) => operation === 'create'), false)

  const later = makeSubdomain('pending', {
    id: 'certv2_z',
    created_at: '2026-09-18T12:00:00.000Z',
  })
  const earlier = makeSubdomain('timed_out', {
    id: 'certv2_a',
    created_at: '2026-09-16T12:00:00.000Z',
  })
  const multiple = makeService([later, earlier])
  const multipleRuntime = createSubdomainRuntime({ root: makeRepo(), service: multiple.service })

  const result = await invoke(multipleRuntime, SUBDOMAIN_TOOL_NAMES.create, {
    hostname: existing.subdomain,
  })

  assert.equal(result.isError, true)
  assert.equal(multipleRuntime.state.outcome, 'needs_user_action')
  assert.match(result.structuredContent.message, /More than one custom subdomain matches/)
  assert.ok(
    result.structuredContent.message.indexOf('certv2_a') <
      result.structuredContent.message.indexOf('certv2_z')
  )
  assert.equal(multiple.calls.some(([operation]) => operation === 'create'), false)
})

test('headless create requires and enforces the explicit hostname', async () => {
  const missing = makeService()
  const missingRuntime = createSubdomainRuntime({
    root: makeRepo(),
    service: missing.service,
    headless: true,
  })

  const missingResult = await invoke(missingRuntime, SUBDOMAIN_TOOL_NAMES.create, {
    hostname: 'metrics.example.com',
  })

  assert.equal(missingResult.isError, true)
  assert.match(missingResult.structuredContent.message, /--subdomain <fqdn>/)
  assert.equal(missing.calls.length, 0)

  const explicit = makeService()
  const explicitRuntime = createSubdomainRuntime({
    root: makeRepo(),
    service: explicit.service,
    headless: true,
    explicitHostname: 'metrics.example.com',
  })
  const mismatch = await invoke(explicitRuntime, SUBDOMAIN_TOOL_NAMES.create, {
    hostname: 'other.example.com',
  })
  const created = await invoke(explicitRuntime, SUBDOMAIN_TOOL_NAMES.create, {
    hostname: 'METRICS.EXAMPLE.COM.',
  })

  assert.equal(mismatch.isError, true)
  assert.match(mismatch.structuredContent.message, /metrics\.example\.com/)
  assert.equal(created.structuredContent.subdomain.subdomain, 'metrics.example.com')
  assert.equal(explicit.calls.filter(([operation]) => operation === 'create').length, 1)
})

test('GET maps every public API status to the run outcome', async () => {
  for (const [status, outcome] of [
    ['pending', 'waiting'],
    ['active', 'active'],
    ['timed_out', 'needs_user_action'],
    ['failed', 'failed'],
  ]) {
    const current = makeSubdomain(status)
    const fake = makeService([current])
    const runtime = createSubdomainRuntime({ root: makeRepo(), service: fake.service })

    const result = await invoke(runtime, SUBDOMAIN_TOOL_NAMES.get, { id: current.id })

    assert.equal(result.structuredContent.subdomain.status, status)
    assert.equal(runtime.state.outcome, outcome)
    if (status === 'pending') {
      assert.deepEqual(runtime.state.pendingDnsRecords, [
        {
          type: 'CNAME',
          host: '_acme-challenge.metrics.example.com',
          value: 'validation.example.com',
          status: 'pending_validation',
        },
        {
          type: 'A',
          host: 'metrics.example.com',
          value: '192.0.2.1',
          status: 'pending_validation',
        },
      ])
    }
  }
})

test('headless verify requires the explicit hostname even after a read selected the resource', async () => {
  const current = makeSubdomain('pending')
  const denied = makeService([current])
  const deniedRuntime = createSubdomainRuntime({
    root: makeRepo(),
    service: denied.service,
    headless: true,
  })

  await invoke(deniedRuntime, SUBDOMAIN_TOOL_NAMES.get, { id: current.id })
  const deniedResult = await invoke(deniedRuntime, SUBDOMAIN_TOOL_NAMES.verify, { id: current.id })

  assert.equal(deniedResult.isError, true)
  assert.match(deniedResult.structuredContent.message, /not selected explicitly/)
  assert.equal(denied.calls.some(([operation]) => operation === 'verify'), false)

  const allowed = makeService([makeSubdomain('pending')])
  const allowedRuntime = createSubdomainRuntime({
    root: makeRepo(),
    service: allowed.service,
    headless: true,
    explicitHostname: 'metrics.example.com',
  })
  const verified = await invoke(allowedRuntime, SUBDOMAIN_TOOL_NAMES.verify, { id: current.id })

  assert.equal(verified.structuredContent.subdomain.status, 'active')
  assert.equal(allowedRuntime.state.outcome, 'active')
  assert.equal(allowed.calls.filter(([operation]) => operation === 'verify').length, 1)
})

test('interactive verify uses a fresh named confirmation', async () => {
  const current = makeSubdomain('pending')
  const fake = makeService([current])
  const decisions = [false, true]
  const prompts = []
  let beforePrompt = 0
  const runtime = createSubdomainRuntime({
    root: makeRepo(),
    service: fake.service,
    beforePrompt: () => {
      beforePrompt += 1
    },
    confirm: async ({ message }) => {
      prompts.push(message)
      return decisions.shift()
    },
  })

  const declined = await invoke(runtime, SUBDOMAIN_TOOL_NAMES.verify, { id: current.id })
  const accepted = await invoke(runtime, SUBDOMAIN_TOOL_NAMES.verify, { id: current.id })

  assert.equal(declined.isError, true)
  assert.deepEqual(declined.structuredContent, {
    outcome: 'needs_user_action',
    message: 'The user declined the DNS check.',
  })
  assert.equal(accepted.structuredContent.subdomain.status, 'active')
  assert.deepEqual(prompts, [
    `Check DNS for ${current.subdomain} (${current.id})?`,
    `Check DNS for ${current.subdomain} (${current.id})?`,
  ])
  assert.equal(beforePrompt, 2)
  assert.equal(fake.calls.filter(([operation]) => operation === 'verify').length, 1)
})

test('verify does not mutate active or terminal resources', async () => {
  for (const [status, outcome] of [
    ['active', 'active'],
    ['timed_out', 'needs_user_action'],
    ['failed', 'failed'],
  ]) {
    const current = makeSubdomain(status)
    const fake = makeService([current])
    const runtime = createSubdomainRuntime({
      root: makeRepo(),
      service: fake.service,
      confirm: async () => {
        throw new Error('Terminal resources must not prompt')
      },
    })

    const result = await invoke(runtime, SUBDOMAIN_TOOL_NAMES.verify, { id: current.id })

    assert.equal(result.structuredContent.subdomain.status, status)
    assert.equal(runtime.state.outcome, outcome)
    assert.equal(fake.calls.some(([operation]) => operation === 'verify'), false)
  }
})

test('delete is denied headlessly and asks for fresh named confirmation every time', async () => {
  const current = makeSubdomain('timed_out')
  const headless = makeService([current])
  const headlessRuntime = createSubdomainRuntime({
    root: makeRepo(),
    service: headless.service,
    headless: true,
    explicitHostname: current.subdomain,
    confirm: async () => {
      throw new Error('Headless delete must not prompt')
    },
  })

  const headlessResult = await invoke(headlessRuntime, SUBDOMAIN_TOOL_NAMES.delete, {
    id: current.id,
  })

  assert.equal(headlessResult.isError, true)
  assert.match(headlessResult.structuredContent.message, /fresh interactive confirmation/)
  assert.equal(headless.calls.some(([operation]) => operation === 'delete'), false)

  const interactive = makeService([makeSubdomain('timed_out')])
  const decisions = [false, true]
  const prompts = []
  const interactiveRuntime = createSubdomainRuntime({
    root: makeRepo(),
    service: interactive.service,
    confirm: async ({ message }) => {
      prompts.push(message)
      return decisions.shift()
    },
  })

  const declined = await invoke(interactiveRuntime, SUBDOMAIN_TOOL_NAMES.delete, { id: current.id })
  const deleted = await invoke(interactiveRuntime, SUBDOMAIN_TOOL_NAMES.delete, { id: current.id })

  assert.equal(declined.isError, true)
  assert.deepEqual(deleted.structuredContent, { id: current.id, deleted: true })
  assert.deepEqual(prompts, [
    `Delete ${current.subdomain} (${current.id}) and revoke its certificate?`,
    `Delete ${current.subdomain} (${current.id}) and revoke its certificate?`,
  ])
  assert.equal(interactive.calls.filter(([operation]) => operation === 'delete').length, 1)
  assert.equal(interactiveRuntime.state.subdomain, undefined)
  assert.equal(interactiveRuntime.state.recreateHostname, current.subdomain)
})

test('timed-out recovery deletes only after confirmation and recreates as waiting', async () => {
  const expired = makeSubdomain('timed_out')
  const fake = makeService([expired])
  const prompts = []
  const runtime = createSubdomainRuntime({
    root: makeRepo(),
    service: fake.service,
    confirm: async ({ message }) => {
      prompts.push(message)
      return true
    },
  })

  await invoke(runtime, SUBDOMAIN_TOOL_NAMES.create, { hostname: expired.subdomain })
  assert.equal(runtime.state.outcome, 'needs_user_action')

  await invoke(runtime, SUBDOMAIN_TOOL_NAMES.delete, { id: expired.id })
  const recreated = await invoke(runtime, SUBDOMAIN_TOOL_NAMES.create, {
    hostname: expired.subdomain,
  })

  assert.equal(recreated.structuredContent.subdomain.status, 'pending')
  assert.equal(runtime.state.outcome, 'waiting')
  assert.deepEqual(prompts, [
    `Delete ${expired.subdomain} (${expired.id}) and revoke its certificate?`,
    `Create the immutable custom subdomain ${expired.subdomain}?`,
  ])
  assert.equal(fake.calls.filter(([operation]) => operation === 'delete').length, 1)
  assert.equal(fake.calls.filter(([operation]) => operation === 'create').length, 1)
})

test('configure endpoint requires an authorized active resource and is idempotent', async () => {
  const root = makeRepo()
  const current = makeSubdomain('active')
  const fake = makeService([current])
  const runtime = createSubdomainRuntime({
    root,
    service: fake.service,
    headless: true,
    explicitHostname: current.subdomain,
  })

  const first = await invoke(runtime, CONFIGURE_SUBDOMAIN_ENDPOINT_TOOL, { id: current.id })
  const contents = readFileSync(join(root, '.env.local'), 'utf8')
  const second = await invoke(runtime, CONFIGURE_SUBDOMAIN_ENDPOINT_TOOL, { id: current.id })

  assert.equal(first.structuredContent.outcome, 'completed')
  assert.equal(first.structuredContent.updated, true)
  assert.equal(second.structuredContent.outcome, 'completed')
  assert.equal(second.structuredContent.updated, false)
  assert.equal(runtime.state.outcome, 'completed')
  assert.equal(readFileSync(join(root, '.env.local'), 'utf8'), contents)
  assert.equal(contents, 'NEXT_PUBLIC_FINGERPRINT_ENDPOINTS=https://metrics.example.com\n')
})

test('completed remains the final outcome after additional reads', async () => {
  const current = makeSubdomain('active')
  const fake = makeService([current])
  const runtime = createSubdomainRuntime({
    root: makeRepo(),
    service: fake.service,
    explicitHostname: current.subdomain,
  })

  await invoke(runtime, SUBDOMAIN_TOOL_NAMES.get, { id: current.id })
  await invoke(runtime, CONFIGURE_SUBDOMAIN_ENDPOINT_TOOL, { id: current.id })
  await invoke(runtime, SUBDOMAIN_TOOL_NAMES.list)
  await invoke(runtime, SUBDOMAIN_TOOL_NAMES.get, { id: current.id })

  assert.equal(runtime.state.outcome, 'completed')
})

test('configure endpoint never writes before active or without an authorized target', async () => {
  for (const [status, outcome] of [
    ['pending', 'waiting'],
    ['timed_out', 'needs_user_action'],
    ['failed', 'failed'],
  ]) {
    const root = makeRepo()
    const current = makeSubdomain(status)
    const fake = makeService([current])
    const runtime = createSubdomainRuntime({
      root,
      service: fake.service,
      headless: true,
      explicitHostname: current.subdomain,
    })

    const result = await invoke(runtime, CONFIGURE_SUBDOMAIN_ENDPOINT_TOOL, { id: current.id })

    assert.equal(result.structuredContent.outcome, outcome)
    assert.equal(runtime.state.outcome, outcome)
    assert.equal(existsSync(join(root, '.env.local')), false)
  }

  const unauthorizedRoot = makeRepo()
  const active = makeSubdomain('active')
  const unauthorized = makeService([active])
  const unauthorizedRuntime = createSubdomainRuntime({
    root: unauthorizedRoot,
    service: unauthorized.service,
    headless: true,
  })

  await invoke(unauthorizedRuntime, SUBDOMAIN_TOOL_NAMES.get, { id: active.id })
  const firstAttempt = await invoke(unauthorizedRuntime, CONFIGURE_SUBDOMAIN_ENDPOINT_TOOL, {
    id: active.id,
  })
  const secondAttempt = await invoke(unauthorizedRuntime, CONFIGURE_SUBDOMAIN_ENDPOINT_TOOL, {
    id: active.id,
  })

  assert.equal(firstAttempt.isError, true)
  assert.equal(secondAttempt.isError, true)
  assert.equal(unauthorizedRuntime.state.outcome, 'needs_user_action')
  assert.equal(existsSync(join(unauthorizedRoot, '.env.local')), false)
})

test('interactive configure requires a fresh named selection', async () => {
  const root = makeRepo()
  const current = makeSubdomain('active')
  const fake = makeService([current])
  const prompts = []
  const decisions = [false, true]
  const runtime = createSubdomainRuntime({
    root,
    service: fake.service,
    confirm: async ({ message }) => {
      prompts.push(message)
      return decisions.shift()
    },
  })

  const declined = await invoke(runtime, CONFIGURE_SUBDOMAIN_ENDPOINT_TOOL, { id: current.id })
  const selected = await invoke(runtime, CONFIGURE_SUBDOMAIN_ENDPOINT_TOOL, { id: current.id })

  assert.equal(declined.isError, true)
  assert.equal(selected.structuredContent.outcome, 'completed')
  assert.deepEqual(prompts, [
    `Use ${current.subdomain} (${current.id}) for this project?`,
    `Use ${current.subdomain} (${current.id}) for this project?`,
  ])
  assert.equal(readFileSync(join(root, '.env.local'), 'utf8'), 'NEXT_PUBLIC_FINGERPRINT_ENDPOINTS=https://metrics.example.com\n')
})

test('list, get, and verify do not poll within one run', async () => {
  const current = makeSubdomain('pending')
  const fake = makeService([current], { verifyStatus: 'pending' })
  const runtime = createSubdomainRuntime({
    root: makeRepo(),
    service: fake.service,
    headless: true,
    explicitHostname: current.subdomain,
  })

  await invoke(runtime, SUBDOMAIN_TOOL_NAMES.list)
  await invoke(runtime, SUBDOMAIN_TOOL_NAMES.list)
  await invoke(runtime, SUBDOMAIN_TOOL_NAMES.get, { id: current.id })
  await invoke(runtime, SUBDOMAIN_TOOL_NAMES.get, { id: current.id })
  await invoke(runtime, SUBDOMAIN_TOOL_NAMES.verify, { id: current.id })
  await invoke(runtime, SUBDOMAIN_TOOL_NAMES.verify, { id: current.id })

  assert.equal(fake.calls.filter(([operation]) => operation === 'list').length, 1)
  assert.equal(fake.calls.filter(([operation]) => operation === 'get').length, 1)
  assert.equal(fake.calls.filter(([operation]) => operation === 'verify').length, 1)
  assert.equal(runtime.state.outcome, 'waiting')
})

test('expected API errors remain actionable within the same run', async () => {
  const create = makeService()
  const createSubdomain = create.service.create
  let rejectsInvalid = true
  create.service.create = async (hostname) => {
    if (rejectsInvalid) {
      rejectsInvalid = false
      throw new ManagementApiError('Invalid custom subdomain', 422)
    }
    return createSubdomain(hostname)
  }
  const createRuntime = createSubdomainRuntime({
    root: makeRepo(),
    service: create.service,
    confirm: async () => true,
  })

  const invalid = await invoke(createRuntime, SUBDOMAIN_TOOL_NAMES.create, {
    hostname: 'invalid.example.com',
  })
  const corrected = await invoke(createRuntime, SUBDOMAIN_TOOL_NAMES.create, {
    hostname: 'metrics.example.com',
  })

  assert.equal(invalid.structuredContent.error.kind, 'invalid_subdomain')
  assert.equal(corrected.structuredContent.subdomain.status, 'pending')
  assert.equal(createRuntime.state.outcome, 'waiting')

  const pending = makeSubdomain('pending')
  const verify = makeService([pending])
  verify.service.verify = async () => {
    throw new ManagementApiError('Too many verification requests', 429, undefined, undefined, '60')
  }
  const verifyRuntime = createSubdomainRuntime({
    root: makeRepo(),
    service: verify.service,
    headless: true,
    explicitHostname: pending.subdomain,
  })

  const rateLimited = await invoke(verifyRuntime, SUBDOMAIN_TOOL_NAMES.verify, { id: pending.id })

  assert.equal(rateLimited.structuredContent.error.kind, 'rate_limited')
  assert.equal(rateLimited.structuredContent.error.retry_after, '60')
  assert.equal(verifyRuntime.state.outcome, 'waiting')
})

for (const [error, kind] of [
  [new NotAuthenticatedError(), 'not_authenticated'],
  [new ManagementApiError('Unauthorized', 401), 'not_authenticated'],
  [new ManagementApiError('Service unavailable', 503), 'unavailable'],
]) {
  test(`runtime requests user action for ${error.status ?? 'missing auth'}`, async () => {
    const fake = makeService()
    fake.service.list = async () => {
      throw error
    }
    const root = makeRepo()
    const runtime = createSubdomainRuntime({ root, service: fake.service, headless: true })

    const result = await invoke(runtime, SUBDOMAIN_TOOL_NAMES.list)

    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.error.kind, kind)
    assert.equal(runtime.state.outcome, 'needs_user_action')
    assert.equal(existsSync(join(root, '.env.local')), false)
  })
}

test('unexpected runtime errors stay failed and block later mutations', async () => {
  const current = makeSubdomain('active')
  const fake = makeService([current])
  const root = makeRepo()
  const runtime = createSubdomainRuntime({
    root,
    service: fake.service,
    headless: true,
    explicitHostname: current.subdomain,
  })

  await invoke(runtime, SUBDOMAIN_TOOL_NAMES.get, { id: current.id })
  const result = await invoke(runtime, SUBDOMAIN_TOOL_NAMES.get, { id: 'missing' })
  const configure = await invoke(runtime, CONFIGURE_SUBDOMAIN_ENDPOINT_TOOL, { id: current.id })

  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.error.kind, 'api_error')
  assert.equal(configure.isError, true)
  assert.equal(runtime.state.outcome, 'failed')
  assert.equal(existsSync(join(root, '.env.local')), false)

  await invoke(runtime, SUBDOMAIN_TOOL_NAMES.get, { id: current.id })
  assert.equal(runtime.state.outcome, 'failed')
})
