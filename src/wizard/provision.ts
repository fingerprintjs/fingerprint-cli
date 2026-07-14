import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { ManagementClient } from '../api/management.js'
import { fetchPublicKey, createSecretKey } from '../api/keys.js'
import { requireAuth } from '../utils/session.js'
import { analyzeRepo, DetectedApp, RepoAnalysis } from './detect.js'
import { log } from './log.js'

// Per-framework env conventions: which file to write, the public/secret-key var names (with
// bundler prefix), the region var names (client needs the bundler-prefixed one; server reads
// FINGERPRINT_REGION), and whether the runtime needs `dotenv` to read .env.
interface EnvConvention {
  file: string
  publicVar?: string
  secretVar?: string
  clientRegionVar?: string
  serverRegionVar?: string
  needsDotenv?: boolean
}

function conventionFor(app: DetectedApp): EnvConvention {
  switch (app.framework) {
    // Fullstack single-repo frameworks: both keys + both region vars in one auto-loaded file.
    case 'next':
      return {
        file: '.env.local',
        publicVar: 'NEXT_PUBLIC_FINGERPRINT_PUBLIC_API_KEY',
        clientRegionVar: 'NEXT_PUBLIC_FINGERPRINT_REGION',
        secretVar: 'FINGERPRINT_SECRET_API_KEY',
        serverRegionVar: 'FINGERPRINT_REGION',
      }
    case 'nuxt':
      return {
        file: '.env',
        publicVar: 'NUXT_PUBLIC_FINGERPRINT_PUBLIC_API_KEY',
        clientRegionVar: 'NUXT_PUBLIC_FINGERPRINT_REGION',
        secretVar: 'FINGERPRINT_SECRET_API_KEY',
        serverRegionVar: 'FINGERPRINT_REGION',
      }
    // Frontend-only (assume a Vite-based toolchain).
    case 'react':
    case 'vue':
    case 'svelte':
    case 'astro':
      return { file: '.env', publicVar: 'VITE_FINGERPRINT_PUBLIC_API_KEY', clientRegionVar: 'VITE_FINGERPRINT_REGION' }
    // Node backends — need dotenv to read a .env file.
    case 'express':
    case 'fastify':
    case 'koa':
    case 'nest':
      return { file: '.env', secretVar: 'FINGERPRINT_SECRET_API_KEY', serverRegionVar: 'FINGERPRINT_REGION', needsDotenv: true }
    // Python backends (python-dotenv typically already used).
    case 'flask':
    case 'fastapi':
    case 'django':
      return { file: '.env', secretVar: 'FINGERPRINT_SECRET_API_KEY', serverRegionVar: 'FINGERPRINT_REGION' }
    default:
      return { file: '.env' }
  }
}

function relevantApps(a: RepoAnalysis): DetectedApp[] {
  return a.apps.filter((x) => x.role === 'frontend' || x.role === 'backend' || x.role === 'fullstack')
}

// Read a var's value from an env file, if present and non-empty.
function readEnvVar(file: string, key: string): string | undefined {
  if (!existsSync(file)) return undefined
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`${key}=`))
  const value = line?.slice(key.length + 1).trim()
  return value || undefined
}

// Upsert vars into an env file, preserving other lines.
function writeEnvFile(file: string, vars: Record<string, string | undefined>): string[] {
  let lines = existsSync(file) ? readFileSync(file, 'utf8').replace(/\n+$/, '').split('\n') : []
  if (lines.length === 1 && lines[0] === '') lines = []

  const written: string[] = []
  for (const [key, value] of Object.entries(vars)) {
    if (!value) continue
    const line = `${key}=${value}`
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`))
    if (idx >= 0) lines[idx] = line
    else lines.push(line)
    written.push(key)
  }
  if (written.length > 0) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, lines.join('\n') + '\n')
  }
  return written
}

// Ensure each written env file is ignored by the repo's root .gitignore, so a provisioned secret
// key can't be committed. Adds an anchored, repo-relative entry per file when nothing already
// covers it (exact line, basename, or a `*` glob like `.env*`). Files outside `root` (e.g. a
// separate backend dir) are skipped and reported to the caller.
function ensureGitignored(root: string, files: string[]): { added: string[]; external: string[] } {
  const gitignore = join(root, '.gitignore')
  const raw = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : ''
  const existing = raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))

  const covers = (rel: string): boolean => {
    const base = rel.split('/').pop()!
    return existing.some((line) => {
      const pat = line.replace(/^\//, '').replace(/\/$/, '')
      if (pat === rel || pat === base) return true
      if (!pat.includes('*')) return false
      const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$')
      return re.test(rel) || re.test(base)
    })
  }

  const added: string[] = []
  const external: string[] = []
  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/')
    if (rel.startsWith('..')) {
      external.push(file)
      continue
    }
    // Anchor to the repo root with a leading '/' so e.g. `.env` doesn't also match in subdirectories.
    const entry = `/${rel}`
    if (!covers(rel) && !added.includes(entry)) added.push(entry)
  }

  if (added.length) {
    const body = (raw && !raw.endsWith('\n') ? raw + '\n' : raw) +
      `# Added by fingerprint CLI — these files contain API keys\n${added.join('\n')}\n`
    writeFileSync(gitignore, body)
  }
  return { added, external }
}

// What provisioning discovered for the downstream integration step. `needsDotenv` is the set of
// backends that must load .env at runtime.
export interface ProvisionResult {
  needsDotenv: DetectedApp[]
}

// Provision real workspace keys into the right per-app .env files, host-side (never via the
// agent, so secrets stay out of the LLM transcript).
export async function provisionForRepo(root: string): Promise<ProvisionResult> {
  const auth = requireAuth()
  const client = new ManagementClient()

  const apps = relevantApps(analyzeRepo(root))

  const publicApps = apps.filter((a) => conventionFor(a).publicVar)
  const secretApps = apps.filter((a) => conventionFor(a).secretVar)

  // The agent region must match the workspace region, or identification fails ("API key not found").
  // It's fixed at login (the Management key is workspace-scoped), so read it from the auth state.
  const region = auth.region
  log.info(`Workspace region: ${region}`)

  const publicKey = publicApps.length ? await fetchPublicKey(client) : undefined
  if (publicKey) log.info('Using existing Public API key.')

  let secretKey: string | undefined
  if (secretApps.length) {
    // Reuse a secret already provisioned into a backend env (don't mint a new key each run).
    for (const app of secretApps) {
      const conv = conventionFor(app)
      secretKey = readEnvVar(join(app.dir, conv.file), conv.secretVar!)
      if (secretKey) break
    }
    if (secretKey) log.info('Reusing existing Secret API key from env.')
    else {
      secretKey = await createSecretKey(client)
      log.info('Created Secret API key.')
    }
  }

  const needsDotenv: DetectedApp[] = []
  const writtenFiles: string[] = []
  for (const app of apps) {
    const conv = conventionFor(app)
    const file = join(app.dir, conv.file)
    const written = writeEnvFile(file, {
      [conv.publicVar ?? '']: conv.publicVar ? publicKey : undefined,
      [conv.secretVar ?? '']: conv.secretVar ? secretKey : undefined,
      [conv.clientRegionVar ?? '']: conv.clientRegionVar ? region : undefined,
      [conv.serverRegionVar ?? '']: conv.serverRegionVar ? region : undefined,
    })
    if (written.length) {
      log.success(`Wrote ${written.join(', ')} → ${join(app.rel, conv.file)}`)
      writtenFiles.push(file)
    }
    if (conv.needsDotenv && conv.secretVar) needsDotenv.push(app)
  }

  // Keep the provisioned secret out of git automatically.
  const { added, external } = ensureGitignored(root, writtenFiles)
  if (added.length) log.success(`Added to .gitignore: ${added.join(', ')}`)
  for (const file of external) log.warn(`${file} is outside this repo — add it to that project's .gitignore manually.`)

  return { needsDotenv }
}
