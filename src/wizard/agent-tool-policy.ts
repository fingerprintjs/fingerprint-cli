import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'
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
