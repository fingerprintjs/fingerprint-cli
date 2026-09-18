import { checkbox, confirm, input, select } from '@inquirer/prompts'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { query, type CanUseTool, type HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'
import { analyzeRepo, DetectedApp, RepoAnalysis } from './detect.js'
import { conventionFor, provisionForRepo } from './provision.js'
import { resolveLlmConfig } from './llm.js'
import { log } from './log.js'
import { renderMarkdown } from '../utils/markdown.js'
import { Spinner, activityFor } from './spinner.js'
import {
  assertAllowedPackage,
  getStartedSkills,
  installSkills,
  skillMeta,
  skillsPluginPath,
  SkillMeta,
} from './skills.js'
import { autoYes, isCi } from '../utils/ci.js'
import { isVerbose } from '../utils/verbose.js'
import { isInteractive } from '../utils/interactive.js'
import { debugLog } from '../utils/log-file.js'
import { createAgentFilePolicy, createAskUserQuestionBridge } from './agent-tool-policy.js'
import {
  CONFIGURE_SUBDOMAIN_ENDPOINT_TOOL,
  createSubdomainRuntime,
  mcpToolName,
  type SubdomainRunOutcome,
  type SubdomainRunState,
} from './subdomain-runtime.js'
import { FINGERPRINT_MCP_SERVER_NAME, SUBDOMAIN_TOOL_NAMES } from './subdomains-mcp.js'

// Tools the agent may use. No Bash: the agent only edits code; the CLI runs package installs
// itself (deterministic, no shell handed to the model). Read-only tools are auto-allowed; the
// mutating ones (Edit/Write) are gated separately so --interactive can prompt before each one.
const READONLY_TOOLS = ['Read', 'Glob', 'Grep']
const EDIT_TOOLS = ['Edit', 'Write']
const ASK_USER_TOOL = 'AskUserQuestion'
const SUBDOMAIN_SKILL = 'fingerprint-proxy-integration'

type AgentEditPhase = 'audit' | 'general' | 'proxy' | 'subdomain_choice' | 'subdomain_locked'

interface AgentEditBoundary {
  state: SubdomainRunState
  explicitHostname?: string
  phase: AgentEditPhase
  skillIds: Set<string>
}

const SUBDOMAIN_READ_TOOLS = [
  mcpToolName(SUBDOMAIN_TOOL_NAMES.list),
  mcpToolName(SUBDOMAIN_TOOL_NAMES.get),
]
const SUBDOMAIN_MUTATION_TOOLS = new Set([
  mcpToolName(SUBDOMAIN_TOOL_NAMES.create),
  mcpToolName(SUBDOMAIN_TOOL_NAMES.verify),
  mcpToolName(SUBDOMAIN_TOOL_NAMES.delete),
  mcpToolName(CONFIGURE_SUBDOMAIN_ENDPOINT_TOOL),
])

// Permission-related query options. Auto mode (default): edits + reads run without prompting.
// Interactive mode: reads/web stay auto-allowed, but Edit/Write prompt before running.
// `extraReadonly` adds read-only tools that should also run without prompting (e.g. WebFetch).
// Both modes carry a hard project boundary so credentials cannot enter the model transcript.
function permissionOptions(
  root: string,
  ui: AgentUi,
  extraReadonly: string[] = [],
  subdomains?: AgentEditBoundary
) {
  const readonly = [...READONLY_TOOLS, ...extraReadonly]
  const questionBridge = createAskUserQuestionBridge({
    headless: isCi(),
    onNeedsUserAction: () => {
      ui.needsUserAction = true
    },
    prompts: {
      input: async (options) => {
        ui.beforePrompt()
        return input(options)
      },
      select: async (options) => {
        ui.beforePrompt()
        return select(options)
      },
      checkbox: async (options) => {
        ui.beforePrompt()
        return checkbox(options)
      },
    },
  })
  const canUseTool: CanUseTool = async (toolName, toolInput, context) => {
    if (toolName === ASK_USER_TOOL) {
      const result = await questionBridge(toolName, toolInput, context)
      if (subdomains?.phase === 'subdomain_choice' && result.behavior === 'allow') {
        const answers = (result.updatedInput as { answers?: Record<string, string> }).answers ?? {}
        const selected = Object.values(answers).join(' ')
        if (/\b(?:proxy|cloudflare worker|cloudfront|lambda@edge|azure|nginx)\b/i.test(selected)) {
          subdomains.phase = 'proxy'
        } else if (
          /\bcustom subdomain\b/i.test(selected) ||
          /\b(?:subdomain|fqdn|dns)\b/i.test(Object.keys(answers).join(' '))
        ) {
          subdomains.phase = 'subdomain_locked'
        }
      }
      return result
    }
    if (SUBDOMAIN_MUTATION_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: toolInput }
    if (toolName === 'Edit' || toolName === 'Write') {
      if (!isInteractive()) return { behavior: 'allow', updatedInput: toolInput }
      const file = (toolInput.file_path ?? toolInput.path) as string | undefined
      const verb = toolName === 'Write' ? 'create/overwrite' : 'edit'
      ui.beforePrompt()
      const ok = await confirm({ message: `Allow the wizard to ${verb} ${file ?? 'a file'}?`, default: true })
      return ok
        ? { behavior: 'allow', updatedInput: toolInput }
        : { behavior: 'deny', message: 'User declined this edit.' }
    }
    return { behavior: 'deny', message: `Tool ${toolName} is not permitted by the wizard.` }
  }
  const allowedTools = [...readonly, ...(isInteractive() ? [] : EDIT_TOOLS), ...(subdomains ? SUBDOMAIN_READ_TOOLS : [])]
  return {
    permissionMode: isInteractive() ? ('default' as const) : ('acceptEdits' as const),
    tools: [...readonly, ...EDIT_TOOLS, ASK_USER_TOOL],
    allowedTools,
    canUseTool,
    hooks: {
      PreToolUse: [
        ...(subdomains ? [createIntegrationPhaseHook(subdomains)] : []),
        createAgentFilePolicy(root, {
          mutationGuard: (_toolName, input) => subdomainEditDenial(subdomains, input),
        }),
      ],
    },
    strictMcpConfig: true,
    persistSession: false,
    settingSources: [],
  }
}

function subdomainEditDenial(
  boundary: AgentEditBoundary | undefined,
  input: Record<string, unknown>
): string | undefined {
  if (!boundary || boundary.state.outcome === 'completed') return undefined
  if (boundary.phase === 'proxy' && boundary.state.outcome === 'idle') return undefined
  if (boundary.phase === 'audit') {
    if (boundary.state.outcome === 'idle') boundary.state.outcome = 'needs_user_action'
    return 'Project files cannot be edited until the integration audit selects a trusted skill.'
  }
  if (boundary.phase === 'subdomain_choice' || boundary.phase === 'subdomain_locked') {
    if (boundary.state.outcome === 'idle') boundary.state.outcome = 'needs_user_action'
    return boundary.phase === 'subdomain_choice'
      ? 'Choose custom subdomain or proxy setup before editing project files.'
      : 'Project files cannot be edited until the active custom subdomain is selected and configured.'
  }
  if (boundary.state.outcome !== 'idle') {
    return 'Project files cannot be edited until the active custom subdomain is selected and configured.'
  }

  const body = [input.content, input.new_string]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
  if (!body) return undefined

  const hostname = boundary.explicitHostname?.trim().replace(/\.$/, '').toLowerCase()
  const changesEndpoint =
    /fingerprint[\w-]*_?endpoints?|\bendpoints?\s*[:=]/i.test(body) ||
    Boolean(hostname && body.toLowerCase().includes(hostname))
  return changesEndpoint
    ? 'Custom subdomain endpoint changes require an active API status first.'
    : undefined
}

function createIntegrationPhaseHook(boundary: AgentEditBoundary): HookCallbackMatcher {
  return {
    hooks: [
      async (event) => {
        if (event.hook_event_name !== 'PreToolUse' || event.tool_name !== 'Skill') return {}
        const rawSkill = (event.tool_input as { skill?: unknown } | undefined)?.skill
        if (typeof rawSkill !== 'string') return {}

        const skill = rawSkill.split(':').at(-1) ?? rawSkill
        if (
          skill === SUBDOMAIN_SKILL &&
          boundary.phase !== 'proxy' &&
          boundary.phase !== 'subdomain_locked'
        ) {
          boundary.phase = boundary.explicitHostname ? 'subdomain_locked' : 'subdomain_choice'
        } else if (
          boundary.phase === 'audit' &&
          skill !== GET_STARTED_SKILL &&
          boundary.skillIds.has(skill)
        ) {
          boundary.phase = 'general'
        }
        return {}
      },
    ],
  }
}

interface AgentUi {
  beforePrompt: () => void
  needsUserAction: boolean
}

// How an integration run ended. `skipped` covers the user declining a prompt (the integration
// itself, or an interactive install) — a choice, not a failure, so it keeps a zero exit code.
// `failed` means the agent or a package install broke; the run must not claim success or exit 0.
export type IntegrateOutcome = 'completed' | 'skipped' | 'waiting' | 'needs_user_action' | 'failed'

interface IntegrateOptions {
  yes?: boolean
  subdomain?: string
}

// Top-level integration flow for a single command invocation: provision env keys, apply one Get
// Started step for `root`, then keep going one step at a time for as long as the user says so.
// Shared by `integrate` and the onboarding chain. Runs in whatever repo it's pointed at; it never
// assumes a particular layout. The CLI adds no closing guidance of its own — the Get Started skill
// the agent follows already tells the user how to verify each step.
export async function integrateProject(root: string, opts: IntegrateOptions = {}): Promise<IntegrateOutcome> {
  let outcome = await provisionAndApply(root, opts)
  // Scripted runs (--yes, --ci) get exactly one step — auto-continuing would loop until the
  // checklist ran dry.
  if (opts.yes || autoYes()) return outcome

  // Steps the user has taken (or declined) this run, plus what the repo already shows. Once a step
  // is behind us it drops out of the menu.
  const done = new Set<NextStep>()
  while (outcome === 'completed') {
    const analysis = analyzeRepo(root)
    if (analysis.backend && hasServerSdk(analysis.backend)) done.add('server')
    const next = await askNextStep(done)
    if (next === 'stop') break
    // `more` stays on offer: each pick is one remaining step, until the audit finds nothing left.
    if (next !== 'more') done.add(next)
    // Server-side verification is the one step that may live in another repo.
    if (next === 'server' && !analysis.backend) {
      const backend = await askBackendPath()
      if (backend) outcome = await provisionAndApply(backend, opts)
      continue
    }
    outcome = await applyIntegration(root, { yes: true, step: NEXT_STEPS[next].step, subdomain: opts.subdomain })
  }
  return outcome
}

// The steps the CLI can offer after one lands. `step` is what the agent is told to do; `more` has
// none, so the agent's audit picks the next not-done step (rules, tagging, request filtering, ...).
type NextStep = 'server' | 'proxy' | 'more'
const NEXT_STEPS: Record<NextStep, { name: string; step?: string }> = {
  server: {
    name: 'Set up server-side verification to get more signals',
    step: 'Quick start step 2 — access detailed insights: verify the event server-side with the Server API',
  },
  proxy: {
    name: 'Protect against ad blockers with a custom subdomain',
    step: 'Quick start step 3 — protect against ad blockers: custom subdomain / proxy integration',
  },
  more: { name: 'Continue with the remaining steps (rules, tagging, request filtering)' },
}

// The user sets the pace: test the step that just landed, then pick the next one. The quick-start
// steps are offered by name; the rest only once those are behind us, so nothing is skipped ahead.
async function askNextStep(done: Set<NextStep>): Promise<NextStep | 'stop'> {
  const quickStartDone = done.has('server') && done.has('proxy')
  const offered = (Object.keys(NEXT_STEPS) as NextStep[]).filter((s) => !done.has(s) && (s !== 'more' || quickStartDone))
  log.line()
  log.info('Test this step now — start your dev server and check the result described above — then choose what to do next.')
  return select<NextStep | 'stop'>({
    message: "What's next?",
    choices: [
      ...offered.map((s) => ({ name: NEXT_STEPS[s].name, value: s })),
      { name: 'Stop here for now (run fingerprint again to continue later)', value: 'stop' },
    ],
  })
}

// Where the backend lives, or undefined to skip the step. Relative paths resolve from the shell's
// cwd, like --path.
async function askBackendPath(): Promise<string | undefined> {
  const path = (await input({ message: 'Server-side verification needs a backend. Path to your backend repo (Enter to skip):' })).trim()
  return path ? resolve(path) : undefined
}

// Step 2 is already in place when the backend depends on the Fingerprint server SDK.
function hasServerSdk(app: DetectedApp): boolean {
  try {
    if (app.language === 'python') {
      return ['requirements.txt', 'pyproject.toml'].some(
        (f) => existsSync(join(app.dir, f)) && readFileSync(join(app.dir, f), 'utf8').includes('fingerprint-server-sdk')
      )
    }
    const pkg = JSON.parse(readFileSync(join(app.dir, 'package.json'), 'utf8'))
    return Boolean(pkg.dependencies?.['@fingerprint/node-sdk'])
  } catch {
    return false
  }
}

// Provision the repo's .env keys, then apply the integration. (Provisioning is host-side so the
// secret never reaches the agent; see provision.ts.)
async function provisionAndApply(root: string, opts: IntegrateOptions): Promise<IntegrateOutcome> {
  log.step('Set up environment variables')
  const { needsDotenv } = await provisionForRepo(root)
  if (needsDotenv.length) {
    log.warn(`Make sure these backend(s) load .env (dotenv): ${needsDotenv.map((a) => a.rel).join(', ')}`)
  }
  return applyIntegration(root, opts)
}

// Offer to apply the integration for the repo at `root` (after env has been provisioned),
// then run the agent, so the flow is continuous: set up env → "integrate this repo?" → apply.
// `step` names one checklist step for the agent to do; without it the agent's audit picks.
async function applyIntegration(
  root: string,
  opts: IntegrateOptions & { step?: string } = {}
): Promise<IntegrateOutcome> {
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
  return runAgent(analysis, opts.step, { subdomain: opts.subdomain })
}

// The Get Started orchestrator skill. It audits the repo, reports the checklist, and dispatches to
// the framework and feature skills for the steps that are not done — which steps, in what order,
// and how to verify each live there, not in a hand-rolled prompt.
const GET_STARTED_SKILL = 'fingerprint-get-started'

export async function runAgent(
  analysis: RepoAnalysis,
  step?: string,
  opts: { subdomain?: string } = {}
): Promise<IntegrateOutcome> {
  if (!analysis.skills.length) throw new Error('No matching skill to apply.')

  const llm = await resolveLlmConfig()
  // The orchestrator drives; the detected framework skills and the feature skills for the later
  // checklist steps are what it can delegate to.
  const ids = [GET_STARTED_SKILL, ...analysis.skills, ...getStartedSkills()]
  const subdomainStep = step === NEXT_STEPS.proxy.step
  const editPhase: AgentEditPhase =
    step === undefined
      ? 'audit'
      : subdomainStep
        ? opts.subdomain
          ? 'subdomain_locked'
          : 'subdomain_choice'
        : 'general'

  // Keep the curated skills available in the repo after the run. This session loads the trusted
  // source as an isolated plugin below, so project settings and hooks never execute.
  installSkills(analysis.root, ids)
  const metas = ids.map(skillMeta)

  const ui: AgentUi = { beforePrompt: () => {}, needsUserAction: false }
  const subdomains = createSubdomainRuntime({
    root: analysis.root,
    explicitHostname: opts.subdomain,
    headless: isCi(),
    beforePrompt: () => ui.beforePrompt(),
  })

  log.step(`Applying ${analysis.skills.join(' + ')} via ${GET_STARTED_SKILL} in ${analysis.root}`)

  const response = query({
    prompt: buildGetStartedPrompt(analysis, step, opts.subdomain),
    options: {
      model: llm.model,
      env: llm.env,
      cwd: analysis.root,
      systemPrompt: SYSTEM_PROMPT,
      plugins: [{ type: 'local', path: skillsPluginPath(), skipMcpDiscovery: true }],
      skills: ids,
      mcpServers: { [FINGERPRINT_MCP_SERVER_NAME]: subdomains.server },
      ...permissionOptions(analysis.root, ui, ['Skill'], {
        state: subdomains.state,
        explicitHostname: opts.subdomain,
        phase: editPhase,
        skillIds: new Set(ids),
      }),
    },
  })

  const run = await consume(response, 'Setting up the integration', ui)
  if (!run.ok) {
    process.exitCode = 1
    return 'failed'
  }

  const subdomainOutcome =
    integrationOutcomeForSubdomain(subdomains.state.outcome) ??
    (ui.needsUserAction ? 'needs_user_action' : undefined)
  if (subdomainOutcome) {
    if (run.text) log.info(renderMarkdown(run.text))
    if (subdomainOutcome === 'needs_user_action' && isCi()) process.exitCode = 1
    if (subdomainOutcome === 'failed') {
      log.error(
        subdomains.state.subdomain?.status === 'failed'
          ? 'Custom subdomain setup failed with a terminal status.'
          : 'Custom subdomain setup failed.'
      )
      process.exitCode = 1
    } else if (subdomainOutcome === 'waiting') {
      const records = subdomains.state.pendingDnsRecords ?? []
      if (records.length) {
        log.info('DNS records still waiting for validation:')
        for (const record of records) log.info(`  ${record.type} ${record.host} → ${record.value}`)
      } else {
        log.info('DNS records are validated; certificate issuance is still in progress.')
      }
      log.info('Re-run the same fingerprint integrate command later.')
    } else if (subdomains.state.subdomain?.status === 'timed_out') {
      log.warn(
        `Custom subdomain ${subdomains.state.subdomain.subdomain} timed out. Delete ${subdomains.state.subdomain.id}, then create it again.`
      )
    } else if (subdomains.state.recreateHostname) {
      log.warn(`Custom subdomain deleted. Create ${subdomains.state.recreateHostname} again to continue.`)
    } else {
      log.warn('Custom subdomain setup needs user action before it can continue.')
    }
    return subdomainOutcome
  }

  const installed = await installPackages(analysis, metas)
  // The agent's final message — what changed and how to verify it — goes after the install output,
  // so it is what the user is reading when asked what to do next.
  if (run.text) log.info(renderMarkdown(run.text))
  if (installed === 'failed') {
    log.warn('The code changes were applied, but package installs failed — the integration cannot run until they are installed (see above).')
    process.exitCode = 1
    return 'failed'
  }
  log.success('Agent finished applying the integration.')
  return installed
}

function integrationOutcomeForSubdomain(outcome: SubdomainRunOutcome): IntegrateOutcome | undefined {
  switch (outcome) {
    case 'waiting':
      return 'waiting'
    case 'active':
    case 'needs_user_action':
      return 'needs_user_action'
    case 'failed':
      return 'failed'
    default:
      return undefined
  }
}

// Drive the agent's message stream to completion. In default mode this shows a live spinner with
// the current high-level activity (the per-step tool calls are hidden); verbose mode, `--ci`, and
// non-TTY (piped/redirected) contexts skip the spinner — its multi-line redraw only works on a live
// TTY — and rely on the streamed/teed log lines instead. `text` is the agent's final message, for
// the caller to print once its own output (package installs) is done; unset when --verbose already
// streamed it.
type AgentRun = { ok: boolean; text?: string }

async function consume(response: unknown, initialMessage: string, ui?: AgentUi): Promise<AgentRun> {
  const spinner = !isVerbose() && process.stdout.isTTY && !isCi() ? new Spinner() : null
  if (ui) ui.beforePrompt = () => spinner?.stop()
  spinner?.start(initialMessage)
  let run: AgentRun = { ok: false }
  try {
    for await (const msg of response as AsyncIterable<any>) {
      const result = handleMessage(msg, spinner)
      if (result) run = result
    }
  } finally {
    spinner?.stop()
  }
  return run
}

const SYSTEM_PROMPT = [
  'You are the Fingerprint integration wizard. Follow .claude/skills/fingerprint-get-started/SKILL.md;',
  'the skills it dispatches to are installed alongside it under .claude/skills/.',
  '',
  'Rules:',
  '- Make minimal, focused changes; match the existing code style.',
  '- The secret key is server-side only; never reference it in frontend code.',
  '- Do NOT read or print .env. Reference keys by env-var name only.',
  '- Manage custom subdomains only through the fingerprint tools. Never ask for or handle a',
  '  Management API key. If status is pending, stop cleanly; do not poll or set endpoints.',
  '- Only after status is active, call configure_subdomain_endpoint and use the returned env var',
  '  in the existing provider/start options.',
  '- Only edit application code. Do not run shell commands, install packages, or touch package',
  '  manifests, lockfiles or package-manager config — the CLI installs the required packages itself',
  '  after you finish. ("v4" in a skill is the Fingerprint platform, not an npm major version.)',
  '- Do not invent app surface: if the repo has no backend, no form, or no sensitive action,',
  "  integrate what's actually there and say what's missing — never scaffold one.",
].join('\n')

// One checklist step per agent run: the one the user picked (`step`), or — on the first run — the
// first the audit shows is not done (install if Fingerprint isn't in the app yet, ...). How to do
// and verify it stays the skill's call; what comes next is the CLI's question to the user, so the
// agent must not pre-empt it. The rest of the prompt is the facts the agent can't read for itself:
// the CLI's stack detection, and where the provisioned keys live (it may not open .env).
function buildGetStartedPrompt(analysis: RepoAnalysis, step?: string, subdomain?: string): string {
  const fe = analysis.frontend ? `frontend (${analysis.frontend.framework}) at ./${analysis.frontend.rel}` : null
  const be = analysis.backend ? `backend (${analysis.backend.framework}) at ./${analysis.backend.rel}` : null
  const publicVar = analysis.frontend ? conventionFor(analysis.frontend).publicVar : undefined
  return [
    step
      ? `Run the Fingerprint Get Started flow for this repository. Do only this step: ${step}.`
      : 'Run the Fingerprint Get Started flow for this repository, one step at a time: do only the first not-done checklist step this repo can do.',
    'Tell the user how to verify it, then stop. Do not announce or suggest what the next step is —',
    'the CLI asks the user about that.',
    `Detected: ${[fe, be].filter(Boolean).join(' and ')}.`,
    'The .env files are already provisioned: the public key is in',
    `${publicVar ?? 'a bundler-prefixed variable'}, the secret key in FINGERPRINT_SECRET_API_KEY.`,
    subdomain
      ? `For the custom-subdomain step, use exactly ${subdomain}; it was supplied by the user.`
      : 'For the custom-subdomain step, ask the user for the FQDN; never guess one.',
  ].join('\n')
}

// Fallback for stacks with no curated skill: the agent researches Fingerprint's docs and
// integrates based on the detected frameworks. Web tools are enabled so it can read the docs.
// No deterministic package install (we have no skill metadata) — it edits the manifest and
// reports the install command instead.
export async function runAgentFromDocs(analysis: RepoAnalysis): Promise<IntegrateOutcome> {
  const llm = await resolveLlmConfig()
  const ui: AgentUi = { beforePrompt: () => {}, needsUserAction: false }
  const response = query({
    prompt: buildDocsTaskPrompt(analysis),
    options: {
      model: llm.model,
      env: llm.env,
      cwd: analysis.root,
      systemPrompt: DOCS_SYSTEM_PROMPT,
      ...permissionOptions(analysis.root, ui, ['WebFetch', 'WebSearch']),
    },
  })

  const run = await consume(response, 'Researching docs and applying the integration', ui)
  if (!run.ok) {
    process.exitCode = 1
    return 'failed'
  }
  if (ui.needsUserAction) {
    if (run.text) log.info(renderMarkdown(run.text))
    log.warn('The integration needs user input before it can continue.')
    if (isCi()) process.exitCode = 1
    return 'needs_user_action'
  }
  if (run.text) log.info(renderMarkdown(run.text))
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

// Returns the run outcome on a final result message, undefined otherwise. Tool calls update the
// spinner's high-level activity (default mode) or stream as lines (--verbose).
function handleMessage(msg: any, spinner: Spinner | null): AgentRun | undefined {
  if (msg.type === 'assistant') {
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) {
        const text = block.text.trim()
        // The agent's running commentary ("let me read…", audit notes, subagent reports) is for the
        // agent, not the user. Only --verbose streams it; otherwise it goes to the debug log (raw —
        // a log full of escape codes reads worse than the markdown) and the user sees the final
        // message alone, returned on the result below.
        if (isVerbose()) log.info(renderMarkdown(text))
        else debugLog(`info  ${text}`)
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
      return { ok: false }
    }
    // The final message is the one thing the user sees from the agent: what changed and how to
    // verify it. The caller prints it (after its package installs); --verbose already streamed it
    // as the last assistant block. The success line is the caller's too — announcing it here would
    // claim success before the install step can still fail.
    const text = typeof msg.result === 'string' ? msg.result.trim() : ''
    return { ok: true, text: !isVerbose() && text ? text : undefined }
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

// pnpm 10 refuses to run a dependency's install scripts until they're approved, and exits 1 even
// though the package itself was installed. From 10.5, `--allow-build=<name>` approves named packages
// on the same `add` and pnpm persists the approval. The CLI only ever installs Fingerprint's own
// packages and known peers (assertAllowedPackage), so approving exactly those is the tool vouching
// for its own vendor, not for arbitrary code. Older pnpm gets no flag and hits PNPM_BLOCKED_BUILDS.
function pnpmAllowBuildFlags(cwd: string, pkgs: string[]): string[] {
  try {
    const version = execFileSync('pnpm', ['--version'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
    const [major, minor] = version.trim().split('.').map(Number)
    if (!(major > 10 || (major === 10 && minor >= 5))) return []
  } catch {
    return []
  }
  return pkgs.map((p) => `--allow-build=${bareName(p)}`)
}

// The package's install scripts were skipped (pnpm < 10.5, or an approval the flag couldn't give).
// The package is installed and works without them for everything the CLI installs.
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
    const flags = bin === 'pnpm' ? pnpmAllowBuildFlags(app.dir, pkgs) : []
    const result = await runPackageInstall(bin, [sub, ...flags, ...pkgs], app.dir)
    if (result.ok) {
      log.success(`Installed in ${app.rel}`)
    } else if (bin === 'pnpm' && PNPM_BLOCKED_BUILDS.test(result.output)) {
      log.success(`Installed in ${app.rel} — pnpm skipped the package's install scripts (optional).`)
      log.info(`  To run them: in ${app.rel}, pnpm approve-builds, then ${bin} ${sub} ${pkgs.join(' ')}`)
    } else {
      failed = true
      log.warn(`Install failed in ${app.rel} — run manually: ${bin} ${sub} ${pkgs.join(' ')}`)
    }
  }
  return failed ? 'failed' : skipped ? 'skipped' : 'completed'
}

// Scoped names start with '@', so a real version specifier is an '@' anywhere after the first
// character (e.g. '@fingerprint/react@^4').
function bareName(pkg: string): string {
  const at = pkg.lastIndexOf('@')
  return at > 0 ? pkg.slice(0, at) : pkg
}

// Append @latest to a package spec that has no version.
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
