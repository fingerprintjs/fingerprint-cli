import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { missingPackages } from '../dist/wizard/packages.js'

function fixture(t, manifest = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fp-packages-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  return { dir, rel: '.', language: 'js', role: 'frontend', packageManager: 'npm' }
}

function installed(dir, name) {
  const path = join(dir, 'node_modules', name)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'index.js'), 'module.exports = {}\n')
}

test('only missing packages are installed, preserving declared dependency versions', (t) => {
  const app = fixture(t, { dependencies: { '@fingerprint/react': '^3.0.0' } })
  installed(app.dir, '@fingerprint/react')
  assert.deepEqual(missingPackages(app, ['@fingerprint/react', '@fingerprint/agent']), ['@fingerprint/agent'])
})

for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  test(`recognizes installed packages in ${field}`, (t) => {
    const app = fixture(t, { [field]: { '@fingerprint/react': '^3' } })
    installed(app.dir, '@fingerprint/react')
    assert.deepEqual(missingPackages(app, ['@fingerprint/react']), [])
  })
}

test('a declaration without an installed package still needs an install', (t) => {
  const app = fixture(t, { dependencies: { '@fingerprint/react': '^3' } })
  assert.deepEqual(missingPackages(app, ['@fingerprint/react']), ['@fingerprint/react'])
})

test('a transitive package still needs to be declared directly by the app', (t) => {
  const app = fixture(t)
  installed(app.dir, '@fingerprint/react')
  assert.deepEqual(missingPackages(app, ['@fingerprint/react']), ['@fingerprint/react'])
})

test('resolves hoisted packages from the app rather than from the CLI', (t) => {
  const root = fixture(t).dir
  installed(root, '@fingerprint/react')
  const dir = join(root, 'web')
  mkdirSync(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@fingerprint/react': '^3' } }))
  assert.deepEqual(missingPackages({ dir, packageManager: 'pnpm' }, ['@fingerprint/react']), [])
})

test('explicit package versions still go through the package manager', (t) => {
  const app = fixture(t, { dependencies: { '@fingerprint/react': '^3' } })
  installed(app.dir, '@fingerprint/react')
  assert.deepEqual(missingPackages(app, ['@fingerprint/react@4']), ['@fingerprint/react@4'])
})
