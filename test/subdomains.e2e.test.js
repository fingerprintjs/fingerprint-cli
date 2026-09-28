import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { makeHome, runCli, seedAuth } from './helpers/harness.js'

const ID = 'certv2_1234567890abcd'
const UNAVAILABLE_MESSAGE =
  'Custom subdomain service is unavailable. This may be temporary, or the feature may be disabled. ' +
  'Check availability with Fingerprint support before retrying.'

function subdomain(overrides = {}) {
  return {
    id: ID,
    subdomain: 'metrics.example.com',
    status: 'pending',
    created_at: '2026-09-15T12:00:00.000Z',
    updated_at: '2026-09-15T12:01:00.000Z',
    webhook_url: null,
    dns_records: {
      verification: {
        type: 'CNAME',
        host: '_acme-challenge.metrics.example.com',
        value: 'validation.fpjs.io',
        status: 'validated',
      },
      routing: [
        { type: 'A', host: 'metrics.example.com', value: '1.2.3.4', status: 'pending_validation' },
        { type: 'A', host: 'metrics.example.com', value: '5.6.7.8', status: 'pending_validation' },
      ],
      caa: {
        type: 'CAA',
        host: 'metrics.example.com',
        value: '0 issue "pki.goog"',
        status: 'pending_validation',
      },
    },
    ...overrides,
  }
}

function listItem(overrides = {}) {
  return {
    id: ID,
    subdomain: 'metrics.example.com',
    status: 'pending',
    created_at: '2026-09-15T12:00:00.000Z',
    updated_at: '2026-09-15T12:01:00.000Z',
    ...overrides,
  }
}

function subdomainWithoutCaa(overrides = {}) {
  const value = subdomain(overrides)
  const { caa: _caa, ...dnsRecords } = value.dns_records
  return { ...value, dns_records: dnsRecords }
}

async function startApi(handler) {
  const requests = []
  const events = []
  const server = createServer((req, res) => {
    let rawBody = ''
    req.on('data', (chunk) => (rawBody += chunk))
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname === '/analytics/events' || url.pathname === '/analytics/anonymous-events') {
        const event = JSON.parse(rawBody)
        events.push(event)
        res.writeHead(202).end()
        return
      }

      const request = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: rawBody ? JSON.parse(rawBody) : undefined,
      }
      requests.push(request)
      const response = handler(request)
      if (!response) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'general.not-found', message: 'not found' } }))
        return
      }

      const { status = 200, headers = {}, body } = response
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(status === 204 ? undefined : JSON.stringify(body))
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    events,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function run(api, args, options = {}) {
  const home = makeHome()
  seedAuth(home, api.url)
  return runCli(args, { home, ...options })
}

test('create returns stable JSON and sends the authenticated Management API request', async () => {
  const api = await startApi((request) => {
    if (request.method === 'POST' && request.path === '/subdomains') {
      return { status: 201, body: { data: { ...subdomain(), webhook_secret: null } } }
    }
  })

  const result = await run(api, ['subdomains', 'create', 'metrics.example.com', '--json'])

  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.deepEqual(output, { data: { ...subdomain(), webhook_secret: null } })
  assert.equal(output.data.id, ID)
  assert.equal(output.data.dns_records.routing.length, 2)
  assert.equal(output.data.dns_records.caa.type, 'CAA')
  assert.doesNotMatch(result.stdout, /mgmt_key_1/)

  const request = api.requests[0]
  assert.deepEqual(request.body, { subdomain: 'metrics.example.com' })
  assert.equal(request.headers.authorization, 'Bearer mgmt_key_1')
  assert.equal(request.headers['x-api-version'], '2025-11-20')

  const completed = api.events.find(({ event }) => event === 'cli_command_run')
  assert.equal(completed.properties.command, 'subdomains-create')
  assert.equal(completed.properties.status, 'ok')
  assert.doesNotMatch(JSON.stringify(api.events), /metrics\.example\.com|validation\.fpjs\.io|mgmt_key_1/)
  await api.close()
})

test('list follows pagination and returns every result', async () => {
  const api = await startApi((request) => {
    if (request.method !== 'GET' || request.path !== '/subdomains') return
    if (!request.query.cursor) {
      return {
        body: {
          data: [listItem()],
          metadata: { pagination: { next_cursor: 'page-2', prev_cursor: null } },
        },
      }
    }
    return {
      body: {
        data: [listItem({ id: 'certv2_abcdefghijklmn', subdomain: 'api.example.com', status: 'active' })],
        metadata: { pagination: { next_cursor: null, prev_cursor: 'page-1' } },
      },
    }
  })

  const result = await run(api, ['subdomains', 'list', '--json'])

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(
    JSON.parse(result.stdout).data.map(({ subdomain: hostname }) => hostname),
    ['metrics.example.com', 'api.example.com']
  )
  assert.equal(api.requests.length, 2)
  assert.deepEqual(api.requests.map(({ query }) => query), [
    { limit: '100' },
    { limit: '100', cursor: 'page-2' },
  ])
  await api.close()
})

test('bare subdomains lists resources and help, while --help works without auth or API requests', async (t) => {
  let items = [listItem()]
  const api = await startApi((request) => {
    if (request.method === 'GET' && request.path === '/subdomains') {
      return { body: { data: items } }
    }
  })
  t.after(() => api.close())

  const help = await runCli(['subdomains', '--help'], {
    home: makeHome(),
    env: { FINGERPRINT_MANAGEMENT_API_URL: api.url },
  })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /Usage:.*subdomains/)
  assert.equal(api.requests.length, 0)

  const result = await run(api, ['subdomains'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /metrics\.example\.com[\s\S]*Usage:.*subdomains/)
  assert.match(result.stdout, /get[^\n]*<id-or-hostname>/)
  assert.match(result.stdout, /verify[^\n]*<id-or-hostname>/)
  assert.match(result.stdout, /delete[^\n]*<id-or-hostname>/)
  assert.deepEqual(api.requests.map(({ method, path }) => `${method} ${path}`), ['GET /subdomains'])

  items = []
  const empty = await run(api, ['subdomains'])
  assert.equal(empty.status, 0, empty.stderr)
  assert.match(empty.stdout, /No custom subdomains found[\s\S]*Usage:.*subdomains/)
})

test('bare subdomains without auth prints only the login error without requesting subdomains', async (t) => {
  const api = await startApi(() => undefined)
  t.after(() => api.close())

  const result = await runCli(['subdomains'], {
    home: makeHome(),
    env: { FINGERPRINT_MANAGEMENT_API_URL: api.url },
  })

  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /fingerprint login/)
  assert.equal(api.requests.length, 0)
})

test('JSON commands without auth return not_authenticated without requesting subdomains', async (t) => {
  const api = await startApi(() => undefined)
  t.after(() => api.close())

  const result = await runCli(['subdomains', 'list', '--json'], {
    home: makeHome(),
    env: { FINGERPRINT_MANAGEMENT_API_URL: api.url },
  })

  assert.equal(result.status, 1)
  assert.deepEqual(JSON.parse(result.stdout).error, {
    kind: 'not_authenticated',
    message: 'Not logged in. Run: fingerprint login',
  })
  assert.equal(api.requests.length, 0)
})

test('bare subdomains prints help and preserves a listing HTTP error with a failing exit status', async (t) => {
  const api = await startApi((request) => {
    if (request.method === 'GET' && request.path === '/subdomains') {
      return {
        status: 500,
        body: { error: { code: 'general.internal-server-error', message: 'Unable to list subdomains' } },
      }
    }
  })
  t.after(() => api.close())

  const result = await run(api, ['subdomains'])

  assert.equal(result.status, 1)
  assert.match(result.stdout, /Usage:.*subdomains/)
  assert.match(result.stderr, /Unable to list subdomains/)
  assert.deepEqual(api.requests.map(({ method, path }) => `${method} ${path}`), ['GET /subdomains'])
})

for (const command of ['get', 'verify', 'delete']) {
  test(`${command} resolves a normalized hostname through every page before using its ID`, async (t) => {
    const api = await startApi((request) => {
      if (request.method === 'GET' && request.path === '/subdomains') {
        return {
          body: request.query.cursor
            ? { data: [listItem({ subdomain: 'METRICS.EXAMPLE.COM.' })] }
            : {
                data: [listItem({ id: 'certv2_other', subdomain: 'other.example.com' })],
                metadata: { pagination: { next_cursor: 'page-2' } },
              },
        }
      }
      if (request.method === 'POST' && request.path === `/subdomains/${ID}/verify`) {
        return { body: { data: subdomain() } }
      }
      if (request.method === 'GET' && request.path === `/subdomains/${ID}`) {
        return { body: { data: subdomain({ status: 'active' }) } }
      }
      if (request.method === 'DELETE' && request.path === `/subdomains/${ID}`) return { status: 204 }
    })
    t.after(() => api.close())

    const args = ['subdomains', command, '  Metrics.Example.Com.  ', '--json']
    if (command === 'delete') args.push('--yes')
    const result = await run(api, args)

    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.data.id, ID)
    if (command === 'delete') assert.deepEqual(output, { data: { id: ID, deleted: true } })
    else assert.equal(output.data.status, 'active')
    assert.deepEqual(api.requests.slice(0, 2).map(({ query }) => query), [
      { limit: '100' },
      { limit: '100', cursor: 'page-2' },
    ])
    assert.deepEqual(api.requests.map(({ method, path }) => `${method} ${path}`), [
      'GET /subdomains',
      'GET /subdomains',
      ...(command === 'verify' ? [`POST /subdomains/${ID}/verify`] : []),
      `GET /subdomains/${ID}`,
      ...(command === 'delete' ? [`DELETE /subdomains/${ID}`] : []),
    ])
  })
}

for (const { command, kind } of [
  { command: 'verify', kind: 'not_found' },
  { command: 'delete', kind: 'ambiguous' },
]) {
  test(`${command} returns ${kind} for hostname lookup without reading or mutating a resource`, async (t) => {
    const api = await startApi((request) => {
      if (request.method !== 'GET' || request.path !== '/subdomains') return
      return {
        body: request.query.cursor
          ? { data: kind === 'ambiguous' ? [listItem({ id: 'certv2_other', subdomain: 'METRICS.EXAMPLE.COM.' })] : [] }
          : {
              data: kind === 'ambiguous' ? [listItem()] : [],
              metadata: { pagination: { next_cursor: 'page-2' } },
            },
      }
    })
    t.after(() => api.close())

    const args = ['subdomains', command, 'metrics.example.com', '--json']
    if (command === 'delete') args.push('--yes')
    const result = await run(api, args)

    assert.equal(result.status, 1)
    const error = JSON.parse(result.stdout).error
    assert.equal(error.kind, kind)
    assert.match(error.message, /metrics\.example\.com/)
    if (kind === 'ambiguous') assert.match(error.message, /\bID\b/)
    assert.deepEqual(api.requests.map(({ method, path }) => `${method} ${path}`), [
      'GET /subdomains',
      'GET /subdomains',
    ])
  })
}

test('get human output includes status and every DNS record', async (t) => {
  const api = await startApi((request) => {
    if (request.method === 'GET' && request.path === `/subdomains/${ID}`) {
      return { body: { data: subdomainWithoutCaa() } }
    }
  })
  t.after(() => api.close())

  const result = await run(api, ['subdomains', 'get', `  ${ID}  `])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /metrics\.example\.com/)
  assert.match(result.stdout, /pending/)
  assert.match(result.stdout, /CNAME[\s\S]*validation\.fpjs\.io/)
  assert.match(result.stdout, /A[\s\S]*1\.2\.3\.4[\s\S]*A[\s\S]*5\.6\.7\.8/)
  assert.doesNotMatch(result.stdout, /\bCAA\b/)
  assert.match(result.stdout, /DNS provider/i)
  assert.match(result.stdout, /Cloudflare.*DNS only/)
  assert.match(result.stdout, /fingerprint subdomains verify metrics\.example\.com/)
  assert.deepEqual(api.requests.map(({ method, path }) => `${method} ${path}`), [`GET /subdomains/${ID}`])
})

test('create directs users to correct DNS when only the CAA record still needs validation', async (t) => {
  const value = subdomain()
  value.dns_records.routing.forEach((record) => (record.status = 'validated'))
  value.dns_records.caa.status = 'failed'
  const api = await startApi((request) => {
    if (request.method === 'POST' && request.path === '/subdomains') {
      return { status: 201, body: { data: { ...value, webhook_secret: null } } }
    }
  })
  t.after(() => api.close())

  const result = await run(api, ['subdomains', 'create', 'metrics.example.com'])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /(?:add|correct)[\s\S]*DNS provider/i)
  assert.match(result.stdout, /fingerprint subdomains verify metrics\.example\.com/)
})

test('verify with all DNS records validated explains setup progress and suggests get instead of verify', async (t) => {
  const value = subdomainWithoutCaa()
  value.dns_records.routing.forEach((record) => (record.status = 'validated'))
  const api = await startApi((request) => {
    if (request.method === 'POST' && request.path === `/subdomains/${ID}/verify`) {
      return { body: { data: subdomain() } }
    }
    if (request.method === 'GET' && request.path === `/subdomains/${ID}`) {
      return { body: { data: value } }
    }
  })
  t.after(() => api.close())

  const result = await run(api, ['subdomains', 'verify', ID])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /setup[\s\S]*in progress/i)
  assert.match(result.stdout, /fingerprint subdomains get metrics\.example\.com/)
  assert.doesNotMatch(result.stdout, /fingerprint subdomains verify/)
  assert.doesNotMatch(result.stdout, /DNS provider/i)
  assert.deepEqual(api.requests.map(({ method, path }) => `${method} ${path}`), [
    `POST /subdomains/${ID}/verify`,
    `GET /subdomains/${ID}`,
  ])
})

test('verify presents the fresh GET representation', async () => {
  const api = await startApi((request) => {
    if (request.method === 'POST' && request.path === `/subdomains/${ID}/verify`) {
      return { body: { data: subdomain() } }
    }
    if (request.method === 'GET' && request.path === `/subdomains/${ID}`) {
      return { body: { data: subdomain({ status: 'active' }) } }
    }
  })

  const result = await run(api, ['subdomains', 'verify', `  ${ID}  `, '--json'])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).data.status, 'active')
  assert.deepEqual(
    api.requests.map(({ method, path }) => `${method} ${path}`),
    [`POST /subdomains/${ID}/verify`, `GET /subdomains/${ID}`]
  )
  await api.close()
})

test('delete requires --yes in CI and deletes only the confirmed resource', async () => {
  const api = await startApi((request) => {
    if (request.method === 'GET' && request.path === `/subdomains/${ID}`) return { body: { data: subdomain() } }
    if (request.method === 'DELETE' && request.path === `/subdomains/${ID}`) return { status: 204 }
  })

  const rejected = await run(api, ['--ci', 'subdomains', 'delete', ID, '--json'])
  assert.equal(rejected.status, 1)
  assert.deepEqual(JSON.parse(rejected.stdout).error, {
    kind: 'confirmation_required',
    message: 'Deleting a subdomain with --json or in non-interactive mode requires --yes.',
  })
  assert.equal(api.requests.length, 0)

  const confirmed = await run(api, ['--ci', 'subdomains', 'delete', `  ${ID}  `, '--json', '--yes'])
  assert.equal(confirmed.status, 0, confirmed.stderr)
  assert.deepEqual(JSON.parse(confirmed.stdout), { data: { id: ID, deleted: true } })
  assert.deepEqual(
    api.requests.map(({ method }) => method),
    ['GET', 'DELETE']
  )
  await api.close()
})

test('interactive delete by hostname names the resolved resource and can be cancelled without mutating the workspace', async (t) => {
  const api = await startApi((request) => {
    if (request.method === 'GET' && request.path === '/subdomains') return { body: { data: [listItem()] } }
    if (request.method === 'GET' && request.path === `/subdomains/${ID}`) return { body: { data: subdomain() } }
    if (request.method === 'DELETE' && request.path === `/subdomains/${ID}`) return { status: 204 }
  })
  t.after(() => api.close())

  const result = await run(api, ['subdomains', 'delete', 'metrics.example.com'], {
    respond: [{ when: /Delete metrics\.example\.com/, send: 'n\n' }],
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Delete metrics\.example\.com \(certv2_1234567890abcd\) and revoke its certificate/)
  assert.match(result.stdout, /Deletion cancelled/)
  assert.deepEqual(api.requests.map(({ method, path }) => `${method} ${path}`), [
    'GET /subdomains',
    `GET /subdomains/${ID}`,
  ])
})

test('JSON errors distinguish authentication, validation, duplicate, limit, rate limiting, and service failures', async (t) => {
  const cases = [
    {
      args: ['subdomains', 'list', '--json'],
      status: 401,
      body: { error: { code: 'general.unauthorized', message: 'Invalid API key' } },
      kind: 'not_authenticated',
      message: 'Invalid API key. Run: fingerprint login',
    },
    {
      args: ['subdomains', 'list', '--json'],
      status: 403,
      body: { error: { code: 'general.forbidden', message: 'Access denied' } },
      kind: 'api_error',
      message: 'Access denied',
    },
    {
      args: ['subdomains', 'create', 'invalid', '--json'],
      status: 422,
      body: {
        error: {
          code: 'validation.failed',
          message: 'Invalid subdomain for mgmt_key_1',
          violations: [{ property: 'subdomain', message: 'mgmt_key_1 is not a valid hostname' }],
        },
      },
      kind: 'invalid_subdomain',
    },
    {
      args: ['subdomains', 'create', 'metrics.example.com', '--json'],
      status: 409,
      body: { error: { code: 'general.conflict', message: 'Subdomain already exists' } },
      kind: 'duplicate',
    },
    {
      args: ['subdomains', 'create', 'metrics.example.com', '--json'],
      status: 400,
      body: { error: { code: 'general.bad-request', message: 'Max limit for subdomains reached: 50' } },
      kind: 'limit_reached',
    },
    {
      args: ['subdomains', 'create', 'metrics.example.com', '--json'],
      status: 409,
      body: { error: { code: 'general.conflict', message: 'Max limit for subdomains reached: 50' } },
      kind: 'limit_reached',
    },
    {
      args: ['subdomains', 'verify', ID, '--json'],
      status: 429,
      body: { error: { code: 'rate-limit.exceeded', message: 'You are sending too many requests' } },
      kind: 'rate_limited',
    },
    {
      args: ['subdomains', 'verify', ID, '--json'],
      status: 429,
      headers: { 'retry-after': '60' },
      body: { error: { code: 'rate-limit.exceeded', message: 'You are sending too many requests' } },
      kind: 'rate_limited',
      retryAfter: '60',
    },
    {
      args: ['subdomains', 'create', 'metrics.example.com', '--json'],
      status: 503,
      body: { error: { code: 'general.unavailable', message: 'Service unavailable. Try again later.' } },
      kind: 'unavailable',
      message: UNAVAILABLE_MESSAGE,
    },
    {
      args: ['subdomains', 'create', 'metrics.example.com', '--json'],
      status: 503,
      headers: { 'retry-after': '60' },
      body: { error: { code: 'general.unavailable', message: 'Service unavailable. Try again later.' } },
      kind: 'unavailable',
      message: UNAVAILABLE_MESSAGE,
      retryAfter: '60',
    },
    {
      args: ['subdomains', 'create', 'metrics.example.com', '--json'],
      status: 500,
      body: { error: { code: 'general.internal-server-error', message: 'Unable to create subdomain' } },
      kind: 'api_error',
      message: 'Unable to create subdomain',
    },
  ]

  for (const fixture of cases) {
    const api = await startApi(() => ({
      status: fixture.status,
      headers: fixture.headers,
      body: fixture.body,
    }))
    t.after(() => api.close())

    const result = await run(api, fixture.args)
    assert.equal(result.status, 1)
    assert.equal(api.requests.length, 1)
    const error = JSON.parse(result.stdout).error
    assert.equal(error.kind, fixture.kind)
    assert.equal(error.status, fixture.status)
    assert.equal(error.code, fixture.body.error.code)
    if (fixture.message) assert.equal(error.message, fixture.message)
    if (fixture.status === 422) assert.equal(error.violations[0].property, 'subdomain')
    if (fixture.status === 422) assert.match(result.stdout, /\[REDACTED\]/)
    if (fixture.retryAfter) assert.equal(error.retry_after, fixture.retryAfter)
    else assert.ok(!('retry_after' in error))
    assert.doesNotMatch(result.stdout + result.stderr, /mgmt_key_1/)
  }
})

test('a live 401 tells the user to log in again', async (t) => {
  const api = await startApi(() => ({
    status: 401,
    body: { error: { code: 'general.unauthorized', message: 'Invalid API key' } },
  }))
  t.after(() => api.close())

  const result = await run(api, ['subdomains', 'list'])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /Invalid API key\. Run: fingerprint login/)
  assert.equal(api.requests.length, 1)
})

test('transport errors remain api_error without suggesting login', async () => {
  const api = await startApi(() => undefined)
  await api.close()

  const result = await run(api, ['subdomains', 'list', '--json'])

  assert.equal(result.status, 1)
  assert.deepEqual(JSON.parse(result.stdout).error, {
    kind: 'api_error',
    message: `Couldn’t reach the Management API at ${api.url}. Check your connection.`,
  })
  assert.doesNotMatch(result.stdout + result.stderr, /fingerprint login/)
})

test('create explains a 503 may mean the feature is disabled without suggesting a retry', async (t) => {
  const api = await startApi(() => ({
    status: 503,
    headers: { 'retry-after': '60' },
    body: { error: { code: 'general.unavailable', message: 'Service unavailable. Try again later.' } },
  }))
  t.after(() => api.close())

  const result = await run(api, ['subdomains', 'create', 'metrics.example.com'])

  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes(UNAVAILABLE_MESSAGE), result.stderr)
  assert.doesNotMatch(result.stdout + result.stderr, /Try again later|Retry after|not_enabled/)
  assert.deepEqual(api.requests.map(({ method, path }) => `${method} ${path}`), ['POST /subdomains'])
})
