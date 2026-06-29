import { confirm } from '@inquirer/prompts'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { query, type CanUseTool, type HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'
import { analyzeRepo, formatAnalysis, DetectedApp, RepoAnalysis } from './detect.js'
import { provisionForRepo } from './provision.js'
import { resolveLlmConfig } from './llm.js'
import { log } from './log.js'
import { color } from '../utils/color.js'
import { Spinner, activityFor } from './spinner.js'
import { assertAllowedPackage, installSkills, skillMeta, SkillMeta } from './skills.js'
import { autoYes, isCi } from '../utils/ci.js'
import { text } from '../utils/prompt.js'
import { isVerbose } from '../utils/verbose.js'
import { isInteractive } from '../utils/interactive.js'
import { debugLog } from '../utils/log-file.js'

// Tools the agent may use. No Bash: the agent only edits code; the CLI runs package installs
// itself (deterministic, no shell handed to the model). Read-only tools are auto-allowed; the
// mutating ones (Edit/Write) are gated separately so --interactive can prompt before each one.
const READONLY_TOOLS = ['Read', 'Glob', 'Grep']
const EDIT_TOOLS = ['Edit', 'Write']

// In interactive mode, prompt before each file edit; deny anything that isn't a known edit tool
// (read-only tools are auto-allowed via allowedTools and never reach here, so a hit means something
// unexpected like Bash). Returns an SDK PermissionResult.
const askBeforeEdit: CanUseTool = async (toolName, input) => {
  if (toolName === 'Edit' || toolName === 'Write') {
    const file = (input.file_path ?? input.path) as string | undefined
    const verb = toolName === 'Write' ? 'create/overwrite' : 'edit'
    const ok = await confirm({ message: `Allow the wizard to ${verb} ${file ?? 'a file'}?`, default: true })
    return ok ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'User declined this edit.' }
  }
  return { behavior: 'deny', message: `Tool ${toolName} is not permitted by the wizard.` }
}

// A .env file in the repo holds the freshly provisioned secret key (see provision.ts). The agent
// legitimately needs Read/Grep for the integration, so we can't drop those tools — instead a
// PreToolUse hook denies them specifically on .env files. Unlike the system-prompt instruction (a
// soft control) or canUseTool (which `acceptEdits` bypasses for auto-allowed read tools), a
// PreToolUse deny is a hard rule that fires in every permission mode, keeping the secret out of the
// LLM transcript and the gateway.
const ENV_FILE = /(^|[/\\])\.env(\.[^/\\]*)?$/

const denyEnvReads: HookCallbackMatcher = {
  hooks: [
    async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {}
      if (input.tool_name !== 'Read' && input.tool_name !== 'Grep') return {}
      const i = (input.tool_input ?? {}) as { file_path?: string; path?: string }
      const target = i.file_path ?? i.path ?? ''
      if (!ENV_FILE.test(target)) return {}
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Reading .env is not allowed — reference keys by env-var name only.',
        },
      }
    },
  ],
}

// Permission-related query options. Auto mode (default): edits + reads run without prompting.
// Interactive mode: reads/web stay auto-allowed, but Edit/Write route through askBeforeEdit.
// `extraReadonly` adds read-only tools that should also run without prompting (e.g. WebFetch).
// Both modes carry the .env deny hook so a secret in .env never reaches the model.
function permissionOptions(extraReadonly: string[] = []) {
  const readonly = [...READONLY_TOOLS, ...extraReadonly]
  const hooks = { PreToolUse: [denyEnvReads] }
  if (!isInteractive()) {
    return { permissionMode: 'acceptEdits' as const, allowedTools: [...readonly, ...EDIT_TOOLS], hooks }
  }
  return { permissionMode: 'default' as const, allowedTools: readonly, canUseTool: askBeforeEdit, hooks }
}

// Whichever side of an integration a repo covers. A fullstack framework (e.g. Next.js) and a
// monorepo with both apps cover both; a standalone frontend or backend covers one.
type IntegrationRole = 'frontend' | 'backend'

function coverageOf(a: RepoAnalysis): IntegrationRole[] {
  const fullstack = a.apps.some((x) => x.role === 'fullstack')
  const roles: IntegrationRole[] = []
  if (fullstack || a.frontend) roles.push('frontend')
  if (fullstack || a.backend) roles.push('backend')
  return roles
}

// Resolve a user-typed project path to an existing directory. Frontend/backend repos are usually
// siblings, so a relative name is tried both under `base` and one level up; absolute paths are
// used as-is. Returns the resolved dir, or undefined if none exists.
function resolveProjectDir(base: string, input: string): string | undefined {
  const candidates = isAbsolute(input) ? [input] : [resolve(base, input), resolve(base, '..', input)]
  return candidates.find((c) => existsSync(c))
}

// Top-level integration flow for a single command invocation: provision env keys + apply the
// integration for `root`, then — based on what `root` covers — explain what's still missing and
// offer to set Fingerprint up in other projects too (a separate frontend/backend, or any other
// repo). Shared by `integrate` and the onboarding chain. Runs in whatever repo it's pointed at;
// it never assumes a particular layout.
export async function integrateProject(root: string, opts: { yes?: boolean } = {}): Promise<void> {
  await provisionAndApply(root, opts)
  await offerOtherProjects(root, opts)
}

// Provision the repo's .env keys, then apply the integration. (Provisioning is host-side so the
// secret never reaches the agent; see provision.ts.)
async function provisionAndApply(root: string, opts: { yes?: boolean }): Promise<void> {
  log.step('Set up environment variables')
  const { needsDotenv } = await provisionForRepo(root)
  if (needsDotenv.length) {
    log.warn(`Make sure these backend(s) load .env (dotenv): ${needsDotenv.map((a) => a.rel).join(', ')}`)
  }
  await applyIntegration(root, opts)
}

// After integrating `root`, Fingerprint only delivers value once BOTH sides exist: the frontend
// identifies visitors and sends an event, and the backend verifies it server-side before trusting
// the action. So guide the user toward whatever side is still missing, and keep offering to set up
// other repos until they decline. Skipped in CI / with --yes (no human to point at the next repo).
async function offerOtherProjects(root: string, opts: { yes?: boolean }): Promise<void> {
  if (isCi() || opts.yes) return

  const covered = new Set<IntegrationRole>(coverageOf(analyzeRepo(root)))

  for (;;) {
    const hasFrontend = covered.has('frontend')
    const hasBackend = covered.has('backend')

    let message: string
    let example: string
    let suggest = true
    if (hasFrontend && !hasBackend) {
      log.info(
        'Your frontend can now identify visitors — but Fingerprint only stops fraud once a backend\n' +
          'verifies those events server-side. Want to set it up in your backend too?'
      )
      message = 'Point me to your backend project?'
      example = '../api'
    } else if (hasBackend && !hasFrontend) {
      log.info(
        'Your backend can now verify Fingerprint events — but it needs a frontend to identify\n' +
          'visitors and send the event data. Want to set it up in your frontend too?'
      )
      message = 'Point me to your frontend project?'
      example = '../web'
    } else {
      message = 'Set up Fingerprint in another project too?'
      example = '../other-app'
      suggest = false // both sides covered — don't nudge, just offer
    }

    const proceed = await confirm({ message, default: suggest })
    if (!proceed) return

    const input = await text(`Path to the project (e.g. ${example}) — blank to skip`)
    if (!input.trim()) return
    const dir = resolveProjectDir(root, input.trim())
    if (!dir) {
      log.warn(`No directory found at "${input.trim()}".`)
      continue
    }

    const target = analyzeRepo(dir)
    console.log(formatAnalysis(target))
    if (!target.skills.length && !target.frontend && !target.backend) {
      log.warn('No supported app detected there — skipping.')
      continue
    }

    await provisionAndApply(dir, opts)
    for (const role of coverageOf(target)) covered.add(role)
  }
}

// Offer to apply the integration for the repo at `root` (after env has been provisioned),
// then run the agent. Called per-repo by `integrateProject` (the main repo plus any follow-up
// projects) so the flow is continuous: set up env → "integrate this repo?" → apply.
async function applyIntegration(root: string, opts: { yes?: boolean } = {}): Promise<void> {
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
      systemPrompt: SYSTEM_PROMPT,
      settingSources: ['project'], // discover .claude/skills/
      skills: ids, // load only the skills we installed, not any others already in the repo
      ...permissionOptions(),
    },
  })

  const ok = await consume(response, 'Setting up the integration')

  if (ok) await installPackages(analysis, metas)
  return ok
}

// Drive the agent's message stream to completion. In default mode this shows a live spinner with
// the current high-level activity (the per-step tool calls are hidden); verbose mode and non-TTY
// (CI) contexts skip the spinner and rely on the streamed/teed log lines instead.
async function consume(response: unknown, initialMessage: string): Promise<boolean> {
  const spinner = !isVerbose() && process.stdout.isTTY ? new Spinner() : null
  spinner?.start(initialMessage)
  let ok = false
  try {
    for await (const msg of response as AsyncIterable<any>) {
      const status = handleMessage(msg, spinner)
      if (status !== undefined) ok = status
    }
  } finally {
    spinner?.stop()
  }
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
  '- Do NOT add dependencies or pin version numbers in package.json / requirements.txt. The CLI',
  '  installs the correct published versions itself; just write the app code that imports them.',
  '  ("v4" in a skill refers to the Fingerprint platform, not an npm package major version.)',
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
      systemPrompt: DOCS_SYSTEM_PROMPT,
      ...permissionOptions(['WebFetch', 'WebSearch']),
    },
  })

  const ok = await consume(response, 'Researching docs and applying the integration')
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
  '- Do NOT guess version numbers. Use "latest" (or leave the range open) unless the docs state a',
  '  specific version — "v4" refers to the Fingerprint platform, not an npm package major version.',
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

// Returns true/false on a final result message, undefined otherwise. When a spinner is active
// (default mode), the agent's narration prints above the live line and tool calls just update the
// high-level activity message; otherwise behavior is unchanged.
function handleMessage(msg: any, spinner: Spinner | null): boolean | undefined {
  if (msg.type === 'assistant') {
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) {
        const text = block.text.trim()
        if (spinner) (spinner.print(`${color.dim('│')} ${text}`), debugLog(`info  ${text}`))
        else log.info(text)
      }
      // Per-step tool calls (Read/Glob/Edit/...) are noisy; only stream them to the console with
      // --verbose. Otherwise update the spinner's high-level activity, and always tee the call to
      // the debug log so failed runs still leave a trail.
      else if (block.type === 'tool_use') {
        const detail = summarizeToolInput(block.name, block.input)
        if (isVerbose()) log.tool(block.name, detail)
        else {
          const activity = activityFor(block.name)
          if (activity) spinner?.setMessage(activity)
          debugLog(`tool  ${block.name}${detail ? ` ${detail}` : ''}`)
        }
      }
    }
    return undefined
  }
  if (msg.type === 'result') {
    spinner?.stop() // clear the live line before printing the final status
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
async function installPackages(analysis: RepoAnalysis, skills: SkillMeta[]): Promise<void> {
  const appForRole: Record<string, DetectedApp | undefined> = {
    frontend: analysis.frontend,
    backend: analysis.backend,
    fullstack: analysis.frontend ?? analysis.backend,
  }
  for (const skill of skills) {
    if (skill.packages.length === 0) continue
    skill.packages.forEach(assertAllowedPackage)
    const app = appForRole[skill.role] ?? analysis.frontend ?? analysis.backend
    if (!app) continue
    const [bin, sub] = installCommand(app.packageManager)
    // The CLI owns dependency versions. For npm-family managers, pin unversioned packages to
    // @latest so the install ignores any (possibly wrong) range the agent wrote into package.json
    // and rewrites it to the real published version. pip/poetry don't use @latest syntax and
    // install latest by name anyway, so leave their packages untouched.
    const jsPm = !['pip', 'poetry'].includes(app.packageManager ?? '')
    const pkgs = jsPm ? skill.packages.map(pinLatest) : skill.packages
    if (isInteractive()) {
      const ok = await confirm({ message: `Install ${pkgs.join(', ')} in ${app.rel}? (${bin} ${sub})`, default: true })
      if (!ok) {
        log.warn(`Skipped — install manually: ${bin} ${sub} ${pkgs.join(' ')} (in ${app.rel})`)
        continue
      }
    }
    log.step(`Installing ${pkgs.join(', ')} in ${app.rel} (${bin})`)
    try {
      execFileSync(bin, [sub, ...pkgs], { cwd: app.dir, stdio: 'inherit' })
      log.success(`Installed in ${app.rel}`)
    } catch {
      log.warn(`Install failed in ${app.rel} — run manually: ${bin} ${sub} ${pkgs.join(' ')}`)
    }
  }
}

// Append @latest to a package spec that has no version. Scoped names start with '@', so a real
// version specifier is an '@' anywhere after the first character (e.g. '@fingerprint/react@^4').
function pinLatest(pkg: string): string {
  return pkg.lastIndexOf('@') > 0 ? pkg : `${pkg}@latest`
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
