import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { color } from '../utils/color.js'
import { log } from './log.js'

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
  skills: string[] // resolved curated skill ids to apply ([] = none, use the docs fallback)
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

// Detected framework → curated skill id (folder in the skills repo).
const FRONTEND_SKILLS: Record<string, string> = {
  react: 'fingerprint-react',
  vue: 'fingerprint-vue',
  angular: 'fingerprint-angular',
  svelte: 'fingerprint-svelte',
}
const BACKEND_SKILLS: Record<string, string> = {
  express: 'fingerprint-node',
  fastify: 'fingerprint-node',
  koa: 'fingerprint-node',
  nest: 'fingerprint-node',
  hapi: 'fingerprint-node',
  fastapi: 'fingerprint-python',
  django: 'fingerprint-python',
  flask: 'fingerprint-python',
}
// Frameworks whose single skill covers both client and server (no separate backend skill needed).
const FULLSTACK_SKILLS: Record<string, string> = {
  next: 'fingerprint-nextjs',
}

// Resolve the curated skill ids for the detected stack. Returns [] when nothing matches
// (the wizard then falls back to a docs-based integration).
function resolveSkills(frontend?: DetectedApp, backend?: DetectedApp): string[] {
  const feFw = frontend?.framework
  if (feFw && FULLSTACK_SKILLS[feFw]) return [FULLSTACK_SKILLS[feFw]]

  const ids: string[] = []
  if (feFw && FRONTEND_SKILLS[feFw]) ids.push(FRONTEND_SKILLS[feFw])
  if (backend?.framework && BACKEND_SKILLS[backend.framework]) ids.push(BACKEND_SKILLS[backend.framework])
  return ids
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
    skills: resolveSkills(frontend, backend),
  }
}

const LANG_LABEL: Record<DetectedApp['language'], string> = {
  ts: 'TypeScript',
  js: 'JavaScript',
  python: 'Python',
  unknown: 'unknown',
}

function displayPath(p: string): string {
  const home = homedir()
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p
}

function appName(app: DetectedApp, root: string): string {
  if (app.rel === '.') return basename(root)
  return app.rel
}

function formatTags(app: DetectedApp): string {
  const parts: string[] = []
  if (app.language !== 'unknown') parts.push(color.cyan(LANG_LABEL[app.language]))
  if (app.packageManager && app.packageManager !== 'unknown') parts.push(color.cyan(app.packageManager))
  if (app.framework) parts.push(color.cyan(app.framework))
  else parts.push(color.dim('framework not detected'))
  return parts.join(color.dim(' · '))
}

function layoutLabel(a: RepoAnalysis): string {
  if (!a.monorepo) return 'single app'
  const pm = a.apps.find((x) => x.packageManager && x.packageManager !== 'unknown')?.packageManager
  if (pm === 'pnpm' && existsSync(join(a.root, 'pnpm-workspace.yaml'))) {
    return `monorepo ${color.dim('·')} pnpm workspace`
  }
  return 'monorepo · multiple apps'
}

/** Print the analysis block with clack-style hierarchy (step + rail + aligned kv). */
export function printAnalysis(a: RepoAnalysis): void {
  log.step('Analyzing project')
  log.kv('Repository', displayPath(a.root))
  log.kv('Layout', layoutLabel(a))
  log.line()
  log.info(color.dim('Apps found'))
  if (a.apps.length === 0) {
    log.info(`  ${color.dim('(none — no package.json or python project found)')}`)
  } else {
    for (const app of a.apps) {
      log.info(`  ${color.bold(appName(app, a.root))}  ${formatTags(app)}`)
    }
  }
  log.line()
  log.kv(
    'Frontend',
    a.frontend ? `${color.cyan(a.frontend.framework ?? 'app')} ${color.dim(`(${a.frontend.rel})`)}` : color.dim('not found')
  )
  log.kv(
    'Backend',
    a.backend ? `${color.cyan(a.backend.framework ?? 'app')} ${color.dim(`(${a.backend.rel})`)}` : color.dim('not found')
  )
  if (a.skills.length) {
    log.line()
    log.kv('Skills', a.skills.map((s) => color.cyan(s)).join(color.dim(' + ')))
  } else if (a.frontend || a.backend) {
    log.line()
    log.info(color.dim('No curated skill for this stack — a docs-based integration can be attempted.'))
  }
}

