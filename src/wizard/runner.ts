import { confirm } from '@inquirer/prompts'
import { execFileSync } from 'node:child_process'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { analyzeRepo, DetectedApp, RepoAnalysis } from './detect.js'
import { resolveLlmConfig } from './llm.js'
import { log } from './log.js'
import { installSkills, skillMeta, SkillMeta } from './skills.js'
import { autoYes } from '../utils/ci.js'

// Tools the agent may use. No Bash: the agent only edits code; the CLI runs package installs
// itself (deterministic, no shell handed to the model).
const ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep']

// Offer to apply the integration for the repo at `root` (after env has been provisioned),
// then run the agent. Shared by `integrate`, `keys`, and the onboarding chain so the flow
// is continuous: detect → set up env → "integrate this repo?" → apply.
export async function applyIntegration(root: string, opts: { yes?: boolean } = {}): Promise<void> {
  const analysis = analyzeRepo(root)

  // No curated skill for this stack. If we still detected a frontend/backend, fall back to a
  // best-effort, docs-researched integration instead of giving up.
  if (!analysis.skills.length) {
    if (!analysis.frontend && !analysis.backend) {
      log.info('No Fingerprint integration is available for this stack yet.')
      return
    }
    const stack = [analysis.frontend?.framework, analysis.backend?.framework].filter(Boolean).join(' + ')
    log.warn(`No curated skill for this stack (${stack}).`)
    const proceed =
      opts.yes ||
      autoYes() ||
      (await confirm({
        message: 'Attempt an experimental, docs-based integration? (researches Fingerprint docs, then edits files)',
        default: true,
      }))
    if (!proceed) return

    log.step('Researching Fingerprint docs and applying integration')
    await runAgentFromDocs(analysis)
    return
  }

  const proceed =
    opts.yes ||
    autoYes() ||
    (await confirm({ message: `Integrate Fingerprint into this repo (${analysis.skills.join(' + ')})? (edits files)`, default: true }))
  if (!proceed) return

  log.step('Apply integration')
  await runAgent(analysis)
}

export async function runAgent(analysis: RepoAnalysis): Promise<boolean> {
  if (!analysis.skills.length) throw new Error('No matching skill to apply.')

  const llm = resolveLlmConfig()
  const ids = analysis.skills

  // Install skills into the repo's .claude/skills/ so the agent reads them on demand,
  // rather than us stuffing their full text into the prompt every turn.
  installSkills(analysis.root, ids)
  const metas = ids.map(skillMeta)

  log.step(`Applying ${ids.join(' + ')} in ${analysis.root}`)

  const response = query({
    prompt: buildTaskPrompt(analysis, ids),
    options: {
      model: llm.model,
      env: llm.env,
      cwd: analysis.root,
      permissionMode: 'acceptEdits',
      systemPrompt: SYSTEM_PROMPT,
      settingSources: ['project'], // discover .claude/skills/
      skills: ids, // load only the skills we installed, not any others already in the repo
      allowedTools: ALLOWED_TOOLS,
    },
  })

  let ok = false
  for await (const msg of response as AsyncIterable<any>) {
    const status = handleMessage(msg)
    if (status !== undefined) ok = status
  }

  if (ok) installPackages(analysis, metas)
  return ok
}

const SYSTEM_PROMPT = [
  'You are the Fingerprint integration wizard. You add Fingerprint device intelligence to a',
  "developer's app for fraud prevention.",
  '',
  'The integration skills are installed under .claude/skills/. For each skill named in the task,',
  'read .claude/skills/<id>/SKILL.md (and its snippets/) and follow it exactly.',
  '',
  'Rules:',
  '- Make minimal, focused changes; match the existing code style.',
  '- The secret key is server-side only; never reference it in frontend code.',
  '- Do NOT read or print .env. Reference keys by env-var name only.',
  '- Only edit code. Do not install packages or run shell commands, and do not tell the user to',
  '  install anything — the CLI installs the required packages automatically after you finish.',
  '- When done, briefly summarize the files you changed.',
].join('\n')

function buildTaskPrompt(analysis: RepoAnalysis, ids: string[]): string {
  const fe = analysis.frontend ? `frontend (${analysis.frontend.framework}) at ./${analysis.frontend.rel}` : null
  const be = analysis.backend ? `backend (${analysis.backend.framework}) at ./${analysis.backend.rel}` : null
  return [
    'Integrate Fingerprint into this repository.',
    `Detected: ${[fe, be].filter(Boolean).join(' and ')}.`,
    'Read and follow each named skill from .claude/skills/<id>/SKILL.md and apply it to the',
    'matching part of the app. The per-app .env files are already provisioned with the keys',
    '(frontend: the bundler-prefixed public key; backend: FINGERPRINT_SECRET_API_KEY).',
    "Protect the app's primary sensitive action (signup if present, else login): identify on the",
    'client, send the event_id, and verify it server-side, blocking bots before completing.',
    `Skills to apply (read each from .claude/skills/<id>/SKILL.md): ${ids.join(', ')}.`,
  ].join('\n')
}

// Fallback for stacks with no curated skill: the agent researches Fingerprint's docs and
// integrates based on the detected frameworks. Web tools are enabled so it can read the docs.
// No deterministic package install (we have no skill metadata) — it edits the manifest and
// reports the install command instead.
export async function runAgentFromDocs(analysis: RepoAnalysis): Promise<boolean> {
  const llm = resolveLlmConfig()
  const response = query({
    prompt: buildDocsTaskPrompt(analysis),
    options: {
      model: llm.model,
      env: llm.env,
      cwd: analysis.root,
      permissionMode: 'acceptEdits',
      systemPrompt: DOCS_SYSTEM_PROMPT,
      allowedTools: [...ALLOWED_TOOLS, 'WebFetch', 'WebSearch'],
    },
  })

  let ok = false
  for await (const msg of response as AsyncIterable<any>) {
    const status = handleMessage(msg)
    if (status !== undefined) ok = status
  }
  if (ok) log.warn('Experimental integration applied from docs — review the changes and install any dependencies it listed.')
  return ok
}

const DOCS_SYSTEM_PROMPT = [
  'You are the Fingerprint integration wizard. No curated skill exists for this stack, so research',
  "Fingerprint's official documentation and integrate based on what you find.",
  '',
  '- Start at https://docs.fingerprint.com/llms.txt and follow the relevant links; prefer v4 docs over v3.',
  '- Use WebFetch/WebSearch to read the docs for the detected frontend and backend frameworks and find',
  '  the correct SDK/package and usage for each. If web access is unavailable, use your own knowledge',
  "  of Fingerprint's v4 SDKs.",
  '',
  'Rules:',
  '- Make minimal, focused changes; match the existing code style.',
  '- The secret key is server-side only; never reference it in frontend code.',
  '- Do NOT read or print .env. Reference keys by env-var name only (client: a bundler-prefixed public',
  '  key, e.g. VITE_/NEXT_PUBLIC_FINGERPRINT_PUBLIC_API_KEY; server: FINGERPRINT_SECRET_API_KEY).',
  '- You MAY add required dependencies to the package manifest (package.json / requirements.txt), but',
  '  do NOT run shell commands. List the exact install command(s) for the user at the end.',
  "- Protect the app's primary sensitive action (signup if present, else login): identify on the client,",
  '  send the event/request id, verify it server-side and block bots before completing the action.',
  '- When done, summarize the files you changed and the packages to install.',
].join('\n')

function buildDocsTaskPrompt(analysis: RepoAnalysis): string {
  const fe = analysis.frontend
    ? `frontend: ${analysis.frontend.framework} (${analysis.frontend.language}) at ./${analysis.frontend.rel}`
    : null
  const be = analysis.backend
    ? `backend: ${analysis.backend.framework} (${analysis.backend.language}) at ./${analysis.backend.rel}`
    : null
  return [
    'Integrate Fingerprint device intelligence into this repository by researching the docs.',
    `Detected ${[fe, be].filter(Boolean).join('; ')}.`,
    'Find the right Fingerprint SDK for each part from the docs, wire up client identification and',
    'server-side verification, and protect the primary sensitive action. The env files may already',
    'contain the public/secret keys under the standard variable names — use those names.',
  ].join('\n')
}

// Returns true/false on a final result message, undefined otherwise.
function handleMessage(msg: any): boolean | undefined {
  if (msg.type === 'assistant') {
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) log.info(block.text.trim())
      else if (block.type === 'tool_use') log.tool(block.name, summarizeToolInput(block.name, block.input))
    }
    return undefined
  }
  if (msg.type === 'result') {
    // A result can carry subtype:'success' yet is_error:true (e.g. an API 429) — check both.
    if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
      log.error(`Agent did not complete: ${msg.result ?? msg.subtype ?? 'unknown error'}`)
      return false
    }
    log.success('Agent finished applying the integration.')
    return true
  }
  return undefined
}

function summarizeToolInput(_name: string, input: any): string {
  if (!input) return ''
  if (input.file_path) return String(input.file_path)
  if (input.path) return String(input.path)
  if (input.pattern) return String(input.pattern)
  return ''
}

// Install each skill's packages into the app that needs them, using that app's package
// manager. Deterministic and host-side — the agent never gets a shell.
function installPackages(analysis: RepoAnalysis, skills: SkillMeta[]): void {
  const appForRole: Record<string, DetectedApp | undefined> = {
    frontend: analysis.frontend,
    backend: analysis.backend,
    fullstack: analysis.frontend ?? analysis.backend,
  }
  for (const skill of skills) {
    if (skill.packages.length === 0) continue
    const app = appForRole[skill.role] ?? analysis.frontend ?? analysis.backend
    if (!app) continue
    const [bin, sub] = installCommand(app.packageManager)
    log.step(`Installing ${skill.packages.join(', ')} in ${app.rel} (${bin})`)
    try {
      execFileSync(bin, [sub, ...skill.packages], { cwd: app.dir, stdio: 'inherit' })
      log.success(`Installed in ${app.rel}`)
    } catch {
      log.warn(`Install failed in ${app.rel} — run manually: ${bin} ${sub} ${skill.packages.join(' ')}`)
    }
  }
}

function installCommand(pm?: string): [string, string] {
  switch (pm) {
    case 'pnpm':
      return ['pnpm', 'add']
    case 'yarn':
      return ['yarn', 'add']
    case 'bun':
      return ['bun', 'add']
    case 'poetry':
      return ['poetry', 'add']
    case 'pip':
      return ['pip', 'install']
    default:
      return ['npm', 'install']
  }
}
