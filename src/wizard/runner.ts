import { confirm } from '@inquirer/prompts'
import { spawn } from 'node:child_process'
import { query, type CanUseTool, type HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'
import { analyzeRepo, DetectedApp, RepoAnalysis } from './detect.js'
import { conventionFor, provisionForRepo } from './provision.js'
import { printHowToVerify } from './closing.js'
import { resolveLlmConfig } from './llm.js'
import { log } from './log.js'
import { color } from '../utils/color.js'
import { renderMarkdown } from '../utils/markdown.js'
import { Spinner, activityFor } from './spinner.js'
import { assertAllowedPackage, installSkills, skillMeta, SkillMeta } from './skills.js'
import { autoYes, isCi } from '../utils/ci.js'
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

// How an integration run ended. `skipped` covers the user declining a prompt (the integration
// itself, or an interactive install) — a choice, not a failure, so it keeps a zero exit code.
// `failed` means the agent or a package install broke; the run must not claim success or exit 0.
export type IntegrateOutcome = 'completed' | 'skipped' | 'failed'

// Top-level integration flow for a single command invocation: provision env keys, apply the
// integration for `root`, then tell the user how to verify it. Shared by
// `integrate` and the onboarding chain. Runs in whatever repo it's pointed at; it never assumes a
// particular layout.
export async function integrateProject(root: string, opts: { yes?: boolean } = {}): Promise<IntegrateOutcome> {
  const outcome = await provisionAndApply(root, opts)
  // Only a completed run has something to verify; after a decline or a failure this would read as
  // the run having succeeded here.
  if (outcome === 'completed') printHowToVerify(analyzeRepo(root))
  return outcome
}

// Provision the repo's .env keys, then apply the integration. (Provisioning is host-side so the
// secret never reaches the agent; see provision.ts.)
async function provisionAndApply(root: string, opts: { yes?: boolean }): Promise<IntegrateOutcome> {
  log.step('Set up environment variables')
  const { needsDotenv } = await provisionForRepo(root)
  if (needsDotenv.length) {
    log.warn(`Make sure these backend(s) load .env (dotenv): ${needsDotenv.map((a) => a.rel).join(', ')}`)
  }
  return applyIntegration(root, opts)
}

// Offer to apply the integration for the repo at `root` (after env has been provisioned),
// then run the agent, so the flow is continuous: set up env → "integrate this repo?" → apply.
async function applyIntegration(root: string, opts: { yes?: boolean } = {}): Promise<IntegrateOutcome> {
  const analysis = analyzeRepo(root)

  // No curated skill for this stack. If we still detected a frontend/backend, fall back to a
  // best-effort, docs-researched integration instead of giving up.
  if (!analysis.skills.length) {
    if (!analysis.frontend && !analysis.backend) {
      log.info('No Fingerprint integration is available for this stack yet.')
      return 'skipped'
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
    if (!proceed) return 'skipped'

    log.step('Researching Fingerprint docs and applying integration')
    return runAgentFromDocs(analysis)
  }

  const proceed =
    opts.yes ||
    autoYes() ||
    (await confirm({ message: `Integrate Fingerprint into this repo (${analysis.skills.join(' + ')})? (edits files)`, default: true }))
  if (!proceed) return 'skipped'

  log.step('Apply integration')
  return runAgent(analysis)
}

// The Get Started orchestrator skill. It audits the repo, reports the checklist, and dispatches to
// the detected framework skills for the steps that are not done — step selection and scope live
// there, not in a hand-rolled prompt.
const GET_STARTED_SKILL = 'fingerprint-get-started'

export async function runAgent(analysis: RepoAnalysis): Promise<IntegrateOutcome> {
  if (!analysis.skills.length) throw new Error('No matching skill to apply.')

  const llm = await resolveLlmConfig()
  // The orchestrator drives; the detected framework skills are what it can delegate to.
  const ids = [GET_STARTED_SKILL, ...analysis.skills]

  // Install skills into the repo's .claude/skills/ so the agent reads them on demand,
  // rather than us stuffing their full text into the prompt every turn.
  installSkills(analysis.root, ids)
  const metas = ids.map(skillMeta)

  log.step(`Applying ${analysis.skills.join(' + ')} via ${GET_STARTED_SKILL} in ${analysis.root}`)

  const response = query({
    prompt: buildQuickStartPrompt(analysis),
    options: {
      model: llm.model,
      env: llm.env,
      cwd: analysis.root,
      systemPrompt: SYSTEM_PROMPT,
      settingSources: ['project'], // discover .claude/skills/
      skills: ids, // load only the skills we installed, not any others already in the repo
      ...permissionOptions(['Skill']), // the orchestrator dispatches via the Skill tool
    },
  })

  const ok = await consume(response, 'Setting up the integration')
  if (!ok) {
    process.exitCode = 1
    return 'failed'
  }

  const installed = await installPackages(analysis, metas)
  if (installed === 'failed') {
    log.warn('The code changes were applied, but package installs failed — the integration cannot run until they are installed (see above).')
    process.exitCode = 1
    return 'failed'
  }
  log.success('Agent finished applying the integration.')
  return installed
}

// Drive the agent's message stream to completion. In default mode this shows a live spinner with
// the current high-level activity (the per-step tool calls are hidden); verbose mode, `--ci`, and
// non-TTY (piped/redirected) contexts skip the spinner — its multi-line redraw only works on a live
// TTY — and rely on the streamed/teed log lines instead.
async function consume(response: unknown, initialMessage: string): Promise<boolean> {
  const spinner = !isVerbose() && process.stdout.isTTY && !isCi() ? new Spinner() : null
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
  'You are the Fingerprint integration wizard. Follow .claude/skills/fingerprint-get-started/SKILL.md;',
  'the skills it dispatches to are installed alongside it under .claude/skills/.',
  '',
  'Rules:',
  '- Make minimal, focused changes; match the existing code style.',
  '- The secret key is server-side only; never reference it in frontend code.',
  '- Do NOT read or print .env. Reference keys by env-var name only.',
  '- Only edit application code. Do not run shell commands, install packages, or touch package',
  '  manifests, lockfiles or package-manager config — the CLI installs the required packages itself',
  '  after you finish. ("v4" in a skill is the Fingerprint platform, not an npm major version.)',
  '- Do not invent app surface: if the repo has no backend, no form, or no sensitive action,',
  "  integrate what's actually there and say what's missing — never scaffold one.",
].join('\n')

// Scope the run to the Quick start steps. The later checklist steps belong after the first
// identification event has landed, which nothing in this run can confirm — the dashboard's Get
// Started page takes over from there.
function buildQuickStartPrompt(analysis: RepoAnalysis): string {
  const fe = analysis.frontend ? `frontend (${analysis.frontend.framework}) at ./${analysis.frontend.rel}` : null
  const be = analysis.backend ? `backend (${analysis.backend.framework}) at ./${analysis.backend.rel}` : null
  const publicVar = analysis.frontend ? conventionFor(analysis.frontend).publicVar : undefined
  return [
    'Run the Fingerprint Get Started flow for this repository.',
    `Detected: ${[fe, be].filter(Boolean).join(' and ')}.`,
    'The .env files are already provisioned: the public key is in',
    `${publicVar ?? 'a bundler-prefixed variable'}, the secret key in FINGERPRINT_SECRET_API_KEY.`,
    'Scope: Quick start step 1 (frontend identification) and step 2 (server-side verification, only',
    'where a backend exists). Skip whatever the audit shows is already in place; do not start later steps.',
  ].join('\n')
}

// Fallback for stacks with no curated skill: the agent researches Fingerprint's docs and
// integrates based on the detected frameworks. Web tools are enabled so it can read the docs.
// No deterministic package install (we have no skill metadata) — it edits the manifest and
// reports the install command instead.
export async function runAgentFromDocs(analysis: RepoAnalysis): Promise<IntegrateOutcome> {
  const llm = await resolveLlmConfig()
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
  if (!ok) {
    process.exitCode = 1
    return 'failed'
  }
  log.success('Agent finished applying the integration.')
  log.warn('Experimental integration applied from docs — review the changes and install any dependencies it listed.')
  return 'completed'
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
        // Rendered for the console, raw for the debug log — a log file full of escape codes is worse
        // to read than the markdown was. Railed per line, the way `log.info` does it: a multi-line
        // block prefixed once leaves every line after the first hanging off the rail.
        if (spinner) {
          for (const line of renderMarkdown(text).split('\n')) spinner.print(`${color.dim('│')} ${line}`)
          debugLog(`info  ${text}`)
        } else log.info(renderMarkdown(text))
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
    // The success line is printed by the caller once the package installs are also done —
    // announcing it here would claim success before the install step can still fail.
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

// Run one package-manager install, streaming its output live while also retaining it — the
// retained text is what lets the caller classify the failure (stdio:'inherit' would discard it).
function runPackageInstall(bin: string, args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ['inherit', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      process.stderr.write(chunk)
    })
    child.on('error', (err) => resolve({ ok: false, output: `${output}${err.message}` }))
    child.on('close', (code) => resolve({ ok: code === 0, output }))
  })
}

// pnpm refusing to run a dependency's build scripts until they're approved (blocks the install
// with a non-zero exit; the fix is pnpm's approve-builds flow, not a retry).
const PNPM_BLOCKED_BUILDS = /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i

// Install each skill's packages into the app that needs them, using that app's package
// manager. Deterministic and host-side — the agent never gets a shell.
// `failed` (an install broke) is distinct from `skipped` (the user declined an interactive
// install — a choice, not a failure, so it must not fail the run).
async function installPackages(analysis: RepoAnalysis, skills: SkillMeta[]): Promise<IntegrateOutcome> {
  const appForRole: Record<string, DetectedApp | undefined> = {
    frontend: analysis.frontend,
    backend: analysis.backend,
    fullstack: analysis.frontend ?? analysis.backend,
  }
  let failed = false
  let skipped = false
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
        skipped = true
        continue
      }
    }
    log.step(`Installing ${pkgs.join(', ')} in ${app.rel} (${bin})`)
    const result = await runPackageInstall(bin, [sub, ...pkgs], app.dir)
    if (result.ok) {
      log.success(`Installed in ${app.rel}`)
    } else if (bin === 'pnpm' && PNPM_BLOCKED_BUILDS.test(result.output)) {
      failed = true
      log.warn(`pnpm blocked a dependency's build scripts in ${app.rel}. To fix it:`)
      log.info(`  1. In ${app.rel}, run: pnpm approve-builds — and approve the listed package(s)`)
      log.info(`  2. Re-run the install: ${bin} ${sub} ${pkgs.join(' ')}`)
    } else {
      failed = true
      log.warn(`Install failed in ${app.rel} — run manually: ${bin} ${sub} ${pkgs.join(' ')}`)
    }
  }
  return failed ? 'failed' : skipped ? 'skipped' : 'completed'
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
