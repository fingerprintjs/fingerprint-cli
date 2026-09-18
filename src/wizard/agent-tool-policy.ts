import type { CanUseTool, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { lstatSync, realpathSync, statSync } from 'node:fs'

const FILE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'Write'])
const ENV_FILE = /^(?:\.env(?:\..+)?|\.envrc)$/
const SECRET_FILE = /^(?:\.mcp\.json|mcp\.json|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.netrc|credentials(?:\.[^.]+)?\.json|id_(?:rsa|dsa|ecdsa|ed25519))$/i
const SECRET_EXTENSION = /\.(?:pem|key|p12|pfx)$/i
const SAFE_GREP_EXTENSIONS = new Set([
  'astro',
  'c',
  'cc',
  'cpp',
  'cs',
  'css',
  'go',
  'h',
  'hpp',
  'html',
  'java',
  'js',
  'jsx',
  'kt',
  'kts',
  'less',
  'mjs',
  'php',
  'py',
  'rb',
  'rs',
  'sass',
  'scss',
  'svelte',
  'swift',
  'ts',
  'tsx',
  'vue',
])

interface FilePolicyOptions {
  authFile?: string
  mutationGuard?: (toolName: 'Edit' | 'Write', input: Record<string, unknown>) => string | undefined
}

export function createAgentFilePolicy(root: string, options: FilePolicyOptions = {}): HookCallbackMatcher {
  const projectRoot = resolveRealPath(root)
  if (!projectRoot) throw new Error(`Cannot resolve project root: ${root}`)

  const authFile = resolveRealPath(options.authFile ?? join(homedir(), '.config', 'fingerprint', 'auth.json'))

  return {
    hooks: [
      async (event) => {
        if (event.hook_event_name !== 'PreToolUse' || !FILE_TOOLS.has(event.tool_name)) return {}

        const toolInput = (event.tool_input ?? {}) as Record<string, unknown>
        if ((event.tool_name === 'Edit' || event.tool_name === 'Write') && options.mutationGuard) {
          const reason = options.mutationGuard(event.tool_name, toolInput)
          if (reason) return denied(reason)
        }
        const requestedPath = pathForTool(event.tool_name, toolInput, projectRoot)
        if (!requestedPath) return denied('A valid project path is required.')

        if (event.tool_name === 'Glob') {
          const pattern = toolInput.pattern
          if (typeof pattern !== 'string' || unsafeGlobPattern(pattern)) {
            return denied('Glob patterns must stay within the project and cannot target protected files.')
          }
        }
        const target = resolveRealPath(requestedPath)
        if (!target || !isWithin(projectRoot, target)) {
          return denied('File tools are restricted to the current project.')
        }

        if (isProtectedPath(requestedPath) || isProtectedPath(target)) {
          return denied('Reading or modifying secret files is not allowed; reference variables by name instead.')
        }

        if (authFile && (target === authFile || (isSearchTool(event.tool_name) && isWithin(target, authFile)))) {
          return denied('The Fingerprint authentication store is not available to the agent.')
        }

        if (event.tool_name === 'Grep' && isDirectory(target)) {
          const glob = toolInput.glob
          if (typeof glob !== 'string' || !safeGrepGlob(glob)) {
            return denied('Grep directory searches require a source-file glob so secret files stay excluded.')
          }
        }

        return {}
      },
    ],
  }
}

function pathForTool(toolName: string, input: Record<string, unknown>, root: string): string | undefined {
  if (toolName === 'Glob' || toolName === 'Grep') {
    if (input.path === undefined) return root
    return typeof input.path === 'string' && input.path ? resolve(root, input.path) : undefined
  }

  return typeof input.file_path === 'string' && input.file_path ? resolve(root, input.file_path) : undefined
}

function resolveRealPath(path: string): string | undefined {
  let current = resolve(path)
  const missing: string[] = []

  while (true) {
    try {
      lstatSync(current)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') return undefined

      const parent = dirname(current)
      if (parent === current) return undefined
      missing.unshift(basename(current))
      current = parent
      continue
    }

    try {
      return resolve(realpathSync(current), ...missing)
    } catch {
      // An existing but dangling symlink cannot be proven to stay in the project.
      return undefined
    }
  }
}

function isWithin(parent: string, target: string): boolean {
  const rel = relative(parent, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isProtectedPath(path: string): boolean {
  const file = basename(path)
  return ENV_FILE.test(file) || SECRET_FILE.test(file) || SECRET_EXTENSION.test(file)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function unsafeGlobPattern(pattern: string): boolean {
  const candidate = pattern.startsWith('!') ? pattern.slice(1) : pattern
  const normalized = candidate.replaceAll('\\', '/')
  return (
    !candidate ||
    isAbsolute(candidate) ||
    win32.isAbsolute(candidate) ||
    candidate.startsWith('~') ||
    /(^|[/,{])\.\.(?=$|[/},])/.test(normalized) ||
    normalized.split(/[/{},]/).some((part) => part.startsWith('.env') || isProtectedPath(part))
  )
}

function safeGrepGlob(pattern: string): boolean {
  if (unsafeGlobPattern(pattern)) return false

  const brace = /\.\{([^{}]+)\}$/.exec(pattern)
  if (brace) {
    const extensions = brace[1].split(',')
    return extensions.length > 0 && extensions.every((extension) => SAFE_GREP_EXTENSIONS.has(extension))
  }

  const extension = /\.([A-Za-z0-9]+)$/.exec(pattern)?.[1]
  return extension !== undefined && SAFE_GREP_EXTENSIONS.has(extension)
}

function isSearchTool(toolName: string): boolean {
  return toolName === 'Grep' || toolName === 'Glob'
}

function denied(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  }
}

interface QuestionOption {
  label: string
  description?: string
}

interface AgentQuestion {
  question: string
  options: QuestionOption[]
  multiSelect?: boolean
}

interface PromptChoice {
  name: string
  value: string
  description?: string
}

export interface AgentQuestionPrompts {
  input(options: { message: string }): Promise<string>
  select(options: { message: string; choices: PromptChoice[] }): Promise<string>
  checkbox(options: { message: string; choices: PromptChoice[] }): Promise<string[]>
}

interface AskUserQuestionBridgeOptions {
  headless: boolean
  prompts: AgentQuestionPrompts
  onNeedsUserAction?: () => void
}

const OTHER = 'other'
const SENSITIVE_QUESTION = /\b(?:api[ _-]?key|credential|password|private[ _-]?key|secret|token)\b/i

export function createAskUserQuestionBridge(options: AskUserQuestionBridgeOptions): CanUseTool {
  return async (toolName, toolInput) => {
    if (toolName !== 'AskUserQuestion') {
      return { behavior: 'deny', message: `Tool ${toolName} is not handled by the user-question bridge.` }
    }

    if (options.headless) {
      options.onNeedsUserAction?.()
      return {
        behavior: 'deny',
        message:
          'User input is required. Re-run without --ci or provide the required non-interactive input (for custom subdomains: --subdomain <fqdn>).',
      }
    }

    const questions = parseQuestions(toolInput.questions)
    if (!questions) {
      options.onNeedsUserAction?.()
      return { behavior: 'deny', message: 'The agent requested an invalid user question.' }
    }
    if (
      questions.some(
        ({ question, options: choices }) =>
          SENSITIVE_QUESTION.test(question) ||
          choices.some(({ label, description }) =>
            SENSITIVE_QUESTION.test(`${label} ${description ?? ''}`)
          )
      )
    ) {
      options.onNeedsUserAction?.()
      return {
        behavior: 'deny',
        message: 'The agent cannot ask for credentials or secrets. Use the host-side authenticated tools.',
      }
    }

    try {
      const answers: Record<string, string> = {}
      for (const question of questions) {
        const choices = question.options.map((option, index) => ({
          name: option.label,
          value: `option:${index}`,
          description: option.description,
        }))
        choices.push({ name: 'Other', value: OTHER, description: 'Type a different answer.' })

        if (question.multiSelect) {
          const selected = await options.prompts.checkbox({ message: question.question, choices })
          const values = selected
            .filter((value) => value !== OTHER)
            .map((value) => labelForChoice(question, value))
            .filter((value): value is string => Boolean(value))
          if (selected.includes(OTHER)) values.push((await options.prompts.input({ message: 'Your answer:' })).trim())
          answers[question.question] = values.filter(Boolean).join(', ')
          continue
        }

        const selected = await options.prompts.select({ message: question.question, choices })
        answers[question.question] =
          selected === OTHER
            ? (await options.prompts.input({ message: 'Your answer:' })).trim()
            : (labelForChoice(question, selected) ?? '')
      }

      return { behavior: 'allow', updatedInput: { ...toolInput, answers } }
    } catch {
      options.onNeedsUserAction?.()
      return { behavior: 'deny', message: 'User input was cancelled.' }
    }
  }
}

function parseQuestions(value: unknown): AgentQuestion[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return undefined

  const questions: AgentQuestion[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return undefined
    const question = candidate as Record<string, unknown>
    if (typeof question.question !== 'string' || !question.question.trim()) return undefined
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 4) return undefined

    const options: QuestionOption[] = []
    for (const candidateOption of question.options) {
      if (!candidateOption || typeof candidateOption !== 'object') return undefined
      const option = candidateOption as Record<string, unknown>
      if (typeof option.label !== 'string' || !option.label.trim()) return undefined
      if (option.description !== undefined && typeof option.description !== 'string') return undefined
      options.push({ label: option.label, description: option.description as string | undefined })
    }

    if (question.multiSelect !== undefined && typeof question.multiSelect !== 'boolean') return undefined
    questions.push({ question: question.question, options, multiSelect: question.multiSelect as boolean | undefined })
  }
  return questions
}

function labelForChoice(question: AgentQuestion, value: string): string | undefined {
  const match = /^option:(\d+)$/.exec(value)
  if (!match) return undefined
  return question.options[Number(match[1])]?.label
}
