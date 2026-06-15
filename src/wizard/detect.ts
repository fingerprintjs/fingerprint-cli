import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export type AppRole = 'frontend' | 'backend' | 'fullstack' | 'unknown'

export interface DetectedApp {
  dir: string // absolute path
  rel: string // path relative to repo root ('.' for root)
  role: AppRole
  language: 'ts' | 'js' | 'python' | 'unknown'
  framework?: string // 'react' | 'next' | 'vue' | 'express' | 'fastify' | 'nest' | 'flask' | 'fastapi' | 'django' | ...
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'pip' | 'poetry' | 'unknown'
}

export interface RepoAnalysis {
  root: string
  monorepo: boolean
  apps: DetectedApp[]
  frontend?: DetectedApp
  backend?: DetectedApp
  skillId?: string // resolved integration skill, if one matches
}

const FRONTEND_FRAMEWORKS: Record<string, string> = {
  next: 'next',
  nuxt: 'nuxt',
  '@remix-run/react': 'remix',
  '@angular/core': 'angular',
  svelte: 'svelte',
  vue: 'vue',
  astro: 'astro',
  'react-native': 'react-native',
  react: 'react', // keep last: many meta-frameworks also depend on react
}

const BACKEND_FRAMEWORKS: Record<string, string> = {
  '@nestjs/core': 'nest',
  express: 'express',
  fastify: 'fastify',
  koa: 'koa',
  '@hapi/hapi': 'hapi',
}

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', 'venv', '.venv'])

function detectPackageManager(dir: string): DetectedApp['packageManager'] {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(dir, 'bun.lockb'))) return 'bun'
  if (existsSync(join(dir, 'package-lock.json'))) return 'npm'
  return undefined
}

function pickFramework(deps: Record<string, string>, table: Record<string, string>): string | undefined {
  for (const [pkg, name] of Object.entries(table)) {
    if (deps[pkg]) return name
  }
  return undefined
}

// Classify a single directory that contains a package.json.
function classifyNodeApp(dir: string, rel: string): DetectedApp {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies }

  const frontend = pickFramework(deps, FRONTEND_FRAMEWORKS)
  const backend = pickFramework(deps, BACKEND_FRAMEWORKS)

  let role: AppRole = 'unknown'
  let framework = frontend ?? backend
  if (frontend && backend) {
    role = 'fullstack'
    framework = frontend // next/nuxt etc. cover both; report the frontend framework
  } else if (frontend) {
    role = 'frontend'
  } else if (backend) {
    role = 'backend'
  }

  const language = existsSync(join(dir, 'tsconfig.json')) || deps.typescript ? 'ts' : 'js'

  return { dir, rel, role, language, framework, packageManager: detectPackageManager(dir) }
}

function classifyPythonApp(dir: string, rel: string): DetectedApp | undefined {
  const req = existsSync(join(dir, 'requirements.txt')) ? readFileSync(join(dir, 'requirements.txt'), 'utf8') : ''
  const pyproject = existsSync(join(dir, 'pyproject.toml')) ? readFileSync(join(dir, 'pyproject.toml'), 'utf8') : ''
  const blob = `${req}\n${pyproject}`.toLowerCase()
  if (!blob.trim()) return undefined

  let framework: string | undefined
  if (blob.includes('fastapi')) framework = 'fastapi'
  else if (blob.includes('django')) framework = 'django'
  else if (blob.includes('flask')) framework = 'flask'

  return {
    dir,
    rel,
    role: framework ? 'backend' : 'unknown',
    language: 'python',
    framework,
    packageManager: pyproject ? 'poetry' : 'pip',
  }
}

// Walk the repo to depth 2 (skipping noise dirs) collecting app manifests.
function findApps(root: string): DetectedApp[] {
  const apps: DetectedApp[] = []

  const visit = (dir: string, depth: number) => {
    const rel = dir === root ? '.' : dir.slice(root.length + 1)
    if (existsSync(join(dir, 'package.json'))) {
      try {
        apps.push(classifyNodeApp(dir, rel))
      } catch {
        /* unreadable/invalid package.json — skip */
      }
    } else {
      const py = classifyPythonApp(dir, rel)
      if (py) apps.push(py)
    }

    if (depth >= 2) return
    for (const entry of readdirSync(dir)) {
      if (IGNORE_DIRS.has(entry) || entry.startsWith('.')) continue
      const child = join(dir, entry)
      try {
        if (statSync(child).isDirectory()) visit(child, depth + 1)
      } catch {
        /* ignore */
      }
    }
  }

  visit(root, 0)
  return apps
}

function resolveSkill(frontend?: DetectedApp, backend?: DetectedApp): string | undefined {
  const fw = frontend?.framework
  const bw = backend?.framework
  // Milestone 1 target: React frontend + Node/Express backend.
  if (fw === 'react' && bw === 'express') return 'react-node-express'
  return undefined
}

export function analyzeRepo(root: string = process.cwd()): RepoAnalysis {
  const apps = findApps(root)

  const frontend = apps.find((a) => a.role === 'frontend') ?? apps.find((a) => a.role === 'fullstack')
  const backend = apps.find((a) => a.role === 'backend')

  const monorepo =
    apps.length > 1 ||
    existsSync(join(root, 'pnpm-workspace.yaml')) ||
    ['apps', 'packages'].some((d) => existsSync(join(root, d)) && statSync(join(root, d)).isDirectory())

  return {
    root,
    monorepo,
    apps,
    frontend,
    backend,
    skillId: resolveSkill(frontend, backend),
  }
}

export function formatAnalysis(a: RepoAnalysis): string {
  const lines: string[] = []
  lines.push(`Repository: ${a.root}`)
  lines.push(`Layout: ${a.monorepo ? 'monorepo / multiple apps' : 'single app'}`)
  lines.push('')
  lines.push('Detected apps:')
  if (a.apps.length === 0) {
    lines.push('  (none — no package.json or python project found)')
  }
  for (const app of a.apps) {
    const fw = app.framework ?? 'unknown framework'
    lines.push(`  - ${app.rel}  [${app.role}]  ${fw}, ${app.language}${app.packageManager ? `, ${app.packageManager}` : ''}`)
  }
  lines.push('')
  lines.push(`Frontend: ${a.frontend ? `${a.frontend.framework} (${a.frontend.rel})` : 'not found'}`)
  lines.push(`Backend:  ${a.backend ? `${a.backend.framework} (${a.backend.rel})` : 'not found'}`)
  lines.push('')
  lines.push(
    a.skillId
      ? `Matched integration skill: ${a.skillId}`
      : a.frontend || a.backend
        ? 'No curated skill for this stack — a docs-based integration can be attempted (experimental).'
        : 'No supported app detected — nothing to integrate.'
  )
  return lines.join('\n')
}
