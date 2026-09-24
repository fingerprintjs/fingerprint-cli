import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentFilePolicy } from '../dist/wizard/agent-tool-policy.js'

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'fp-agent-policy-'))
  const root = join(base, 'repo')
  const outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(root, 'app.ts'), 'export {}\n')
  writeFileSync(join(root, '.env'), 'SECRET=value\n')
  writeFileSync(join(root, '.envrc'), 'export SECRET=value\n')
  writeFileSync(join(root, '.mcp.json'), '{"mcpServers":{}}\n')
  writeFileSync(join(root, '.npmrc'), '//registry.example.test/:_authToken=secret\n')
  writeFileSync(join(outside, 'secret.txt'), 'secret\n')
  return { base, root, outside }
}

async function runHook(policy, toolName, toolInput) {
  return policy.hooks[0]({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'tool_1',
    session_id: 'session_1',
    transcript_path: '',
    cwd: '',
  })
}

function reason(result) {
  return result.hookSpecificOutput?.permissionDecisionReason
}

test('file policy allows project files and source searches', async () => {
  const { root } = fixture()
  const policy = createAgentFilePolicy(root)

  assert.deepEqual(await runHook(policy, 'Read', { file_path: join(root, 'app.ts') }), {})
  assert.deepEqual(await runHook(policy, 'Write', { file_path: join(root, 'new.ts') }), {})
  assert.deepEqual(await runHook(policy, 'Grep', { pattern: 'export', glob: '**/*.ts' }), {})
  assert.deepEqual(await runHook(policy, 'Glob', { pattern: '**/*.ts' }), {})
})

test('file policy rejects paths outside the project and symlink escapes', async () => {
  const { root, outside } = fixture()
  symlinkSync(join(outside, 'secret.txt'), join(root, 'linked-secret'))
  symlinkSync(join(outside, 'not-created.txt'), join(root, 'dangling-secret'))
  symlinkSync(outside, join(root, 'linked-dir'))
  const policy = createAgentFilePolicy(root)

  for (const [toolName, toolInput] of [
    ['Read', { file_path: join(outside, 'secret.txt') }],
    ['Read', { file_path: join(root, 'linked-secret') }],
    ['Write', { file_path: join(root, 'dangling-secret') }],
    ['Write', { file_path: join(root, 'linked-dir', 'new.txt') }],
    ['Grep', { pattern: 'secret', path: outside }],
    ['Glob', { pattern: '**/*', path: join(root, 'linked-dir') }],
  ]) {
    assert.match(reason(await runHook(policy, toolName, toolInput)), /current project/)
  }
})

test('file policy rejects environment and authentication files', async () => {
  const { root } = fixture()
  const authFile = join(root, '.config', 'fingerprint', 'auth.json')
  mkdirSync(join(root, '.config', 'fingerprint'), { recursive: true })
  writeFileSync(authFile, '{"managementApiKey":"secret"}')
  symlinkSync(authFile, join(root, 'auth-link'))
  const policy = createAgentFilePolicy(root, { authFile })

  assert.match(reason(await runHook(policy, 'Read', { file_path: join(root, '.env') })), /secret files/)
  assert.match(reason(await runHook(policy, 'Read', { file_path: join(root, '.envrc') })), /secret files/)
  assert.match(reason(await runHook(policy, 'Edit', { file_path: join(root, '.env.local') })), /secret files/)
  assert.match(reason(await runHook(policy, 'Read', { file_path: join(root, '.mcp.json') })), /secret files/)
  assert.match(reason(await runHook(policy, 'Read', { file_path: join(root, '.npmrc') })), /secret files/)
  assert.match(
    reason(await runHook(policy, 'Grep', { pattern: 'SECRET', glob: '.env' })),
    /authentication store|source-file glob/
  )
  assert.match(reason(await runHook(policy, 'Read', { file_path: authFile })), /authentication store/)
  assert.match(reason(await runHook(policy, 'Read', { file_path: join(root, 'auth-link') })), /authentication store/)
  assert.match(reason(await runHook(policy, 'Grep', { pattern: 'secret', path: join(root, '.config') })), /authentication store/)
})

test('file policy rejects glob traversal, absolute patterns, and protected filenames', async () => {
  const { root } = fixture()
  const policy = createAgentFilePolicy(root)

  for (const pattern of [
    '../**',
    'src/{../secret,*.ts}',
    '/tmp/**',
    'C:\\Users\\secret\\**',
    '**/.env*',
    '**/{.env,.env.local}',
  ]) {
    assert.match(reason(await runHook(policy, 'Glob', { pattern })), /patterns must stay within the project/)
  }
})

test('file policy limits directory grep to source files', async () => {
  const { root } = fixture()
  const policy = createAgentFilePolicy(root)

  for (const glob of ['**/*', '**/.[e]nv', '**/.{env,env.local}', '**/*.{ts,env}']) {
    assert.match(reason(await runHook(policy, 'Grep', { pattern: 'secret', path: root, glob })), /source-file glob/)
  }
  assert.match(reason(await runHook(policy, 'Grep', { pattern: 'secret', path: root })), /source-file glob/)
  assert.deepEqual(await runHook(policy, 'Grep', { pattern: 'export', path: root, glob: '**/*.{ts,tsx}' }), {})
  assert.deepEqual(await runHook(policy, 'Grep', { pattern: 'export', path: join(root, 'app.ts') }), {})
})

test('file policy applies the host mutation guard before writes', async () => {
  const { root } = fixture()
  const policy = createAgentFilePolicy(root, {
    mutationGuard: (_toolName, input) =>
      String(input.content ?? '').includes('endpoints') ? 'Subdomain is not active.' : undefined,
  })

  assert.match(
    reason(await runHook(policy, 'Write', { file_path: join(root, 'app.ts'), content: 'endpoints: "https://example.com"' })),
    /not active/
  )
  assert.deepEqual(
    await runHook(policy, 'Write', { file_path: join(root, 'app.ts'), content: 'export {}' }),
    {}
  )
})
