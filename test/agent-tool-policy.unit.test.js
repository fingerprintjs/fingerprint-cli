import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentFilePolicy, createAskUserQuestionBridge } from '../dist/wizard/agent-tool-policy.js'

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

function prompts(overrides = {}) {
  return {
    input: async () => 'typed answer',
    select: async ({ choices }) => choices[0].value,
    checkbox: async ({ choices }) => [choices[0].value],
    ...overrides,
  }
}

const question = (overrides = {}) => ({
  question: 'Which subdomain should be used?',
  header: 'Subdomain',
  options: [
    { label: 'metrics.example.com', description: 'Use the existing subdomain.' },
    { label: 'api.example.com', description: 'Use the other subdomain.' },
  ],
  multiSelect: false,
  ...overrides,
})

test('question bridge returns selected answers keyed by the original question', async () => {
  const bridge = createAskUserQuestionBridge({
    headless: false,
    prompts: prompts({ select: async ({ choices }) => choices[1].value }),
  })

  const result = await bridge('AskUserQuestion', { questions: [question()] }, {})

  assert.equal(result.behavior, 'allow')
  assert.deepEqual(result.updatedInput.answers, { 'Which subdomain should be used?': 'api.example.com' })
})

test('question bridge supports freeform Other answers', async () => {
  let inputCalls = 0
  const bridge = createAskUserQuestionBridge({
    headless: false,
    prompts: prompts({
      select: async ({ choices }) => choices.at(-1).value,
      input: async () => {
        inputCalls++
        return ' custom.example.com '
      },
    }),
  })

  const result = await bridge('AskUserQuestion', { questions: [question()] }, {})

  assert.equal(result.behavior, 'allow')
  assert.equal(result.updatedInput.answers['Which subdomain should be used?'], 'custom.example.com')
  assert.equal(inputCalls, 1)
})

test('question bridge combines checkbox selections with a freeform answer', async () => {
  const bridge = createAskUserQuestionBridge({
    headless: false,
    prompts: prompts({
      checkbox: async ({ choices }) => [choices[0].value, choices.at(-1).value],
      input: async () => 'another.example.com',
    }),
  })

  const result = await bridge(
    'AskUserQuestion',
    { questions: [question({ question: 'Which subdomains?', multiSelect: true })] },
    {}
  )

  assert.equal(result.behavior, 'allow')
  assert.equal(result.updatedInput.answers['Which subdomains?'], 'metrics.example.com, another.example.com')
})

test('question bridge fails actionably without invoking prompts in headless mode', async () => {
  const fail = async () => assert.fail('prompted in headless mode')
  let needsUserAction = false
  const bridge = createAskUserQuestionBridge({
    headless: true,
    prompts: { input: fail, select: fail, checkbox: fail },
    onNeedsUserAction: () => {
      needsUserAction = true
    },
  })

  const result = await bridge('AskUserQuestion', { questions: [question()] }, {})

  assert.equal(result.behavior, 'deny')
  assert.match(result.message, /without --ci/)
  assert.match(result.message, /--subdomain <fqdn>/)
  assert.equal(needsUserAction, true)
})

test('question bridge rejects malformed requests and reports prompt cancellation', async () => {
  let needsUserAction = 0
  const malformed = createAskUserQuestionBridge({
    headless: false,
    prompts: prompts(),
    onNeedsUserAction: () => {
      needsUserAction++
    },
  })
  const malformedResult = await malformed('AskUserQuestion', { questions: [] }, {})
  assert.deepEqual(malformedResult, { behavior: 'deny', message: 'The agent requested an invalid user question.' })
  assert.equal(needsUserAction, 1)

  const cancelled = createAskUserQuestionBridge({
    headless: false,
    prompts: prompts({ select: async () => Promise.reject(new Error('cancelled')) }),
    onNeedsUserAction: () => {
      needsUserAction++
    },
  })
  const cancelledResult = await cancelled('AskUserQuestion', { questions: [question()] }, {})
  assert.deepEqual(cancelledResult, { behavior: 'deny', message: 'User input was cancelled.' })
  assert.equal(needsUserAction, 2)
})

test('question bridge refuses to collect credentials', async () => {
  let needsUserAction = false
  const bridge = createAskUserQuestionBridge({
    headless: false,
    prompts: prompts({
      select: async () => assert.fail('credential prompts must not reach the user'),
    }),
    onNeedsUserAction: () => {
      needsUserAction = true
    },
  })

  const result = await bridge(
    'AskUserQuestion',
    {
      questions: [
        question({
          question: 'Which Management API key should I use?',
          options: [
            { label: 'Paste token', description: 'Provide a credential.' },
            { label: 'Cancel', description: 'Stop here.' },
          ],
        }),
      ],
    },
    {}
  )

  assert.deepEqual(result, {
    behavior: 'deny',
    message: 'The agent cannot ask for credentials or secrets. Use the host-side authenticated tools.',
  })
  assert.equal(needsUserAction, true)
})
