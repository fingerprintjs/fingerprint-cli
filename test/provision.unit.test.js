import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provisionActiveSubdomainEndpoint } from '../dist/wizard/provision.js'

function makeRepo() {
  return mkdtempSync(join(tmpdir(), 'fp-provision-'))
}

function writePackage(dir, dependencies) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies }))
}

test('provisions a Next.js endpoint idempotently in .env.local', () => {
  const root = makeRepo()
  writePackage(root, { next: '^15' })
  const envFile = join(root, '.env.local')
  writeFileSync(envFile, 'OTHER=value\nNEXT_PUBLIC_FINGERPRINT_ENDPOINTS=https://old.example.com\n')

  const first = provisionActiveSubdomainEndpoint(root, 'metrics.example.com')
  const firstContents = readFileSync(envFile, 'utf8')
  const second = provisionActiveSubdomainEndpoint(root, 'metrics.example.com')

  assert.deepEqual(first, {
    outcome: 'configured',
    endpoint: 'https://metrics.example.com',
    envFile: '.env.local',
    envVar: 'NEXT_PUBLIC_FINGERPRINT_ENDPOINTS',
    updated: true,
  })
  assert.deepEqual(second, { ...first, updated: false })
  assert.equal(readFileSync(envFile, 'utf8'), firstContents)
  assert.equal(firstContents.match(/^NEXT_PUBLIC_FINGERPRINT_ENDPOINTS=/gm)?.length, 1)
  assert.match(firstContents, /^OTHER=value$/m)
})

test('provisions only the selected frontend in a frontend/backend monorepo', () => {
  const root = makeRepo()
  const frontend = join(root, 'web')
  const backend = join(root, 'api')
  writePackage(frontend, { react: '^19' })
  writePackage(backend, { express: '^5' })

  const result = provisionActiveSubdomainEndpoint(root, 'metrics.example.com')

  assert.deepEqual(result, {
    outcome: 'configured',
    endpoint: 'https://metrics.example.com',
    envFile: 'web/.env',
    envVar: 'VITE_FINGERPRINT_ENDPOINTS',
    updated: true,
  })
  assert.equal(readFileSync(join(frontend, '.env'), 'utf8'), 'VITE_FINGERPRINT_ENDPOINTS=https://metrics.example.com\n')
  assert.equal(existsSync(join(backend, '.env')), false)
})

test('uses the Nuxt public env convention', () => {
  const root = makeRepo()
  writePackage(root, { nuxt: '^4' })

  const result = provisionActiveSubdomainEndpoint(root, 'metrics.example.com')

  assert.deepEqual(result, {
    outcome: 'configured',
    endpoint: 'https://metrics.example.com',
    envFile: '.env',
    envVar: 'NUXT_PUBLIC_FINGERPRINT_ENDPOINTS',
    updated: true,
  })
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'NUXT_PUBLIC_FINGERPRINT_ENDPOINTS=https://metrics.example.com\n')
})

test('returns no_frontend without writing for a backend-only repo', () => {
  const root = makeRepo()
  writePackage(root, { express: '^5' })

  assert.deepEqual(provisionActiveSubdomainEndpoint(root, 'metrics.example.com'), { outcome: 'no_frontend' })
  assert.equal(existsSync(join(root, '.env')), false)
  assert.equal(existsSync(join(root, '.gitignore')), false)
})
