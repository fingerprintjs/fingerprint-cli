import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { referencesEndpoint } from '../dist/wizard/endpoint-config.js'

const endpoint = 'https://metrics.example.com'
const envVar = 'VITE_FINGERPRINT_ENDPOINTS'

test('endpoint options can use the selected hostname or its environment variable', () => {
  for (const value of [
    `'${endpoint}'`,
    `["${endpoint}"]`,
    'import.meta.env.VITE_FINGERPRINT_ENDPOINTS',
    '[process.env.VITE_FINGERPRINT_ENDPOINTS!]',
    'process.env["VITE_FINGERPRINT_ENDPOINTS"]',
    'import.meta.env.VITE_FINGERPRINT_ENDPOINTS as string',
    'process.env.VITE_FINGERPRINT_ENDPOINTS ? [process.env.VITE_FINGERPRINT_ENDPOINTS] : undefined',
    'import.meta.env.VITE_FINGERPRINT_ENDPOINTS ?? undefined',
    'import.meta.env.VITE_FINGERPRINT_ENDPOINTS || undefined',
    'import.meta.env.VITE_FINGERPRINT_ENDPOINTS && [import.meta.env.VITE_FINGERPRINT_ENDPOINTS]',
  ]) {
    assert.equal(referencesEndpoint(`const options = { endpoints: ${value} }`, endpoint, envVar), true, value)
  }
})

test('a React provider with an optional endpoint array is configured', () => {
  const code = readFileSync(new URL('./fixtures/subdomain-provider.tsx', import.meta.url), 'utf8')
  assert.equal(referencesEndpoint(code, endpoint, envVar), true)
})

test('local const aliases and shorthand options resolve only when used as the endpoint', () => {
  for (const code of [
    'const endpoints = import.meta.env.VITE_FINGERPRINT_ENDPOINTS; const options = { apiKey, endpoints }',
    'const endpoints = import.meta.env.VITE_FINGERPRINT_ENDPOINTS\nconst options = { endpoints }',
    'const endpoint = process.env["VITE_FINGERPRINT_ENDPOINTS"]; const options = { endpoints: [endpoint] }',
    'const endpoint = import.meta.env.VITE_FINGERPRINT_ENDPOINTS\nconst endpoints = endpoint ? [endpoint] : undefined\nconst options = { endpoints }',
    'const endpoint = import.meta.env.VITE_FINGERPRINT_ENDPOINTS; const provider = <FingerprintProvider endpoints={endpoint} />',
  ]) {
    assert.equal(referencesEndpoint(code, endpoint, envVar), true, code)
  }
})

test('JSX provider props can use the endpoint directly or through the environment', () => {
  for (const value of [
    `"${endpoint}"`,
    `{'${endpoint}'}`,
    '{import.meta.env.VITE_FINGERPRINT_ENDPOINTS}',
    '{[process.env.VITE_FINGERPRINT_ENDPOINTS!]}',
  ]) {
    assert.equal(referencesEndpoint(`<FingerprintProvider endpoints=${value}>`, endpoint, envVar), true, value)
  }
})

test('comments, instructions, unused variables and another hostname do not configure an endpoint', () => {
  for (const code of [
    '// endpoints: import.meta.env.VITE_FINGERPRINT_ENDPOINTS',
    '/* endpoints: import.meta.env.VITE_FINGERPRINT_ENDPOINTS */',
    '<!-- endpoints: import.meta.env.VITE_FINGERPRINT_ENDPOINTS -->',
    'const instructions = "endpoints: import.meta.env.VITE_FINGERPRINT_ENDPOINTS"',
    'const unused = import.meta.env.VITE_FINGERPRINT_ENDPOINTS',
    'const endpoints = import.meta.env.VITE_FINGERPRINT_ENDPOINTS;',
    '<FingerprintProvider endpoints={import.meta.env.VITE_FINGERPRINT_ENDPOINTS_OLD}>',
    'const options = { endpoints: "https://other.example.com" }',
    'const options = { endpoints: import.meta.env.VITE_FINGERPRINT_ENDPOINTS_OLD }',
    `const options = { endpoints: '${endpoint}' + '.other' }`,
    'const options = { endpoints: import.meta.env.VITE_FINGERPRINT_ENDPOINTS ? ["https://other.example.com"] : undefined }',
    'const options = { endpoints: import.meta.env.VITE_FINGERPRINT_ENDPOINTS + ".other" }',
    'const options = { endpoints: import.meta.env.VITE_FINGERPRINT_ENDPOINTS as string + ".other" }',
    'const options = { endpoints: undefined, unused: import.meta.env.VITE_FINGERPRINT_ENDPOINTS }',
    '<FingerprintProvider endpoints={undefined} unused={import.meta.env.VITE_FINGERPRINT_ENDPOINTS} />',
    'const endpoints = "https://other.example.com"; const options = { endpoints }',
    'const endpoints = other; const other = endpoints; const options = { endpoints }',
    'let endpoints = import.meta.env.VITE_FINGERPRINT_ENDPOINTS; const options = { endpoints }',
    'const instructions = "const endpoints = import.meta.env.VITE_FINGERPRINT_ENDPOINTS"; const options = { endpoints }',
    '// const endpoints = import.meta.env.VITE_FINGERPRINT_ENDPOINTS\nconst options = { endpoints }',
    `const environment = { fingerprintEndpoints: '${endpoint}' }`,
  ]) {
    assert.equal(referencesEndpoint(code, endpoint, envVar), false, code)
  }
})
