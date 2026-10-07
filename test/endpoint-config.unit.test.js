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

test('the Vue plugin setup from the skill, with endpoints added, is configured', () => {
  // The documented @fingerprint/vue install: app.use(FingerprintPlugin, options). No provider component.
  const code = [
    "import { createApp } from 'vue'",
    "import { FingerprintPlugin } from '@fingerprint/vue'",
    "import App from './App.vue'",
    '',
    'const app = createApp(App)',
    '',
    'app.use(FingerprintPlugin, {',
    '  apiKey: import.meta.env.VITE_FINGERPRINT_PUBLIC_API_KEY,',
    '  region: import.meta.env.VITE_FINGERPRINT_REGION,',
    '  endpoints: import.meta.env.VITE_FINGERPRINT_ENDPOINTS,',
    '})',
    '',
    "app.mount('#app')",
  ].join('\n')
  assert.equal(referencesEndpoint(code, endpoint, envVar), true)
  assert.equal(referencesEndpoint(code.replace('  endpoints: import.meta.env.VITE_FINGERPRINT_ENDPOINTS,\n', ''), endpoint, envVar), false)
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
    'const endpoints: string[] = [import.meta.env.VITE_FINGERPRINT_ENDPOINTS]\nconst options = { endpoints }',
    'const endpoint: string | undefined = import.meta.env.VITE_FINGERPRINT_ENDPOINTS\nconst options = { endpoints: endpoint ? [endpoint] : undefined }',
  ]) {
    assert.equal(referencesEndpoint(code, endpoint, envVar), true, code)
  }
})

test('const alias initializers can start on the next line', () => {
  for (const code of [
    'const endpoint =\n  import.meta.env.VITE_FINGERPRINT_ENDPOINTS\nconst options = { endpoints: endpoint }',
    'const endpoints =\n\n  process.env["VITE_FINGERPRINT_ENDPOINTS"]; const options = { endpoints }',
    `const endpoint = // custom subdomain\n  '${endpoint}'; const provider = <FingerprintProvider endpoints={endpoint} />`,
  ]) {
    assert.equal(referencesEndpoint(code, endpoint, envVar), true, code)
  }
})

test('the selected endpoint must be first in a failover array', () => {
  for (const value of [`'${endpoint}'`, 'import.meta.env.VITE_FINGERPRINT_ENDPOINTS']) {
    assert.equal(referencesEndpoint(`const options = { endpoints: [${value}, 'https://other.example.com'] }`, endpoint, envVar), true)
    assert.equal(referencesEndpoint(`const options = { endpoints: ['https://other.example.com', ${value}] }`, endpoint, envVar), false)
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
