import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The store keys by workspace and project path, so it must be loaded with HOME pointing at a
// scratch config dir; both modules read HOME when they are first imported.
process.env.HOME = mkdtempSync(join(tmpdir(), 'fp-setups-home-'))
const { saveAuthState } = await import('../dist/auth/tokenStore.js')
const { pendingSubdomainSetup, savePendingSubdomainSetup, clearPendingSubdomainSetup } = await import(
  '../dist/wizard/subdomain-setups.js'
)

test('remembers the chosen hostname per workspace and project, and forgets it on demand', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'fp-setups-repo-')))
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'fp-setups-other-')))
  mkdirSync(join(repo, 'nested'))
  saveAuthState({ workspaceId: 'sub_one', managementApiKey: 'key', region: 'us' })

  assert.equal(pendingSubdomainSetup(repo), undefined)
  savePendingSubdomainSetup(repo, 'metrics.example.com')
  assert.equal(pendingSubdomainSetup(repo)?.hostname, 'metrics.example.com')
  assert.equal(pendingSubdomainSetup(other), undefined, 'another project has its own setup')
  assert.deepEqual(pendingSubdomainSetup(join(repo, 'nested', '..')), pendingSubdomainSetup(repo), 'paths are resolved')

  saveAuthState({ workspaceId: 'sub_two', managementApiKey: 'key', region: 'us' })
  assert.equal(pendingSubdomainSetup(repo), undefined, 'another workspace does not see it')

  saveAuthState({ workspaceId: 'sub_one', managementApiKey: 'key', region: 'us' })
  clearPendingSubdomainSetup(repo)
  assert.equal(pendingSubdomainSetup(repo), undefined)
})
