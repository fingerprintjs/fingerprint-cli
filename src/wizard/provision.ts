import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { ManagementClient } from '../api/management.js'
import { fetchPublicKey } from '../api/keys.js'
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

export function conventionFor(app: DetectedApp): EnvConvention {
  const conv = conventionForFramework(app.framework)
  // One manifest with both halves (react + express, vanilla + express) resolves to the frontend's
  // convention, which carries no secret var — leaving the backend half with no key to verify with.
  // The fullstack frameworks (next/nuxt) declare both already and fall through untouched.
  if (app.role === 'fullstack' && !conv.secretVar) {
    return { ...conv, secretVar: 'FINGERPRINT_SECRET_API_KEY', serverRegionVar: 'FINGERPRINT_REGION', needsDotenv: true }
  }
  return conv
}

function conventionForFramework(framework?: string): EnvConvention {
  switch (framework) {
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
    // No framework SDK, but still a bundled app — same Vite assumption as above. This is the
    // convention `fingerprint-javascript`'s snippets read.
    case 'vanilla':
    case 'solid':
    case 'lit':
    case 'alpine':
    case 'htmx':
    case 'jquery':
      return { file: '.env', publicVar: 'VITE_FINGERPRINT_PUBLIC_API_KEY', clientRegionVar: 'VITE_FINGERPRINT_REGION' }
    // Static site, no build step: nothing reads a .env, so there is no var to write — the key and
    // region are inlined in the code instead (see `inlinesPublicKey`).
    case 'html':
      return { file: '.env' }
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

// An app with no env-var mechanism at all: a static site loads the agent from the CDN, where the
// public key is part of the import URL and the region is a `start()` argument. Both values ship in
// the page source no matter what, so the integration has to receive them literally.
// Deliberately narrow to the static case: a framework app with no `publicVar` yet (remix,
// react-native) has a build step and its own env convention, so it isn't handed a literal key.
export function inlinesPublicKey(app: DetectedApp): boolean {
  return app.framework === 'html'
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
  // Values the integration must write into the code because the app has no env file to read them
  // from (see `inlinesPublicKey`). Public by design — they ship in the page source either way.
  // Never the secret key, which stays out of the agent's reach entirely.
  inline?: { publicKey?: string; region: string }
}

// Provision real workspace keys into the right per-app .env files, host-side (never via the
// agent, so secrets stay out of the LLM transcript).
export async function provisionForRepo(root: string): Promise<ProvisionResult> {
  const auth = requireAuth()
  const client = new ManagementClient()

  const apps = relevantApps(analyzeRepo(root))

  const publicApps = apps.filter((a) => conventionFor(a).publicVar)
  const secretApps = apps.filter((a) => conventionFor(a).secretVar)
  // Static sites need the public key too — just handed to the integration rather than written to a file.
  const inlineApps = apps.filter(inlinesPublicKey)

  // The agent region must match the workspace region, or identification fails ("API key not found").
  // It's fixed at login (the Management key is workspace-scoped), so read it from the auth state.
  const region = auth.region
  log.info(`Workspace region: ${region}`)

  const publicKey = publicApps.length || inlineApps.length ? await fetchPublicKey(client) : undefined
  if (publicKey) log.info('Using existing Public API key.')

  let secretKey: string | undefined
  if (secretApps.length) {
    // Reuse a secret already provisioned into a backend env; otherwise use the Server API key from the
    // login bundle. The CLI never mints keys itself.
    for (const app of secretApps) {
      const conv = conventionFor(app)
      secretKey = readEnvVar(join(app.dir, conv.file), conv.secretVar!)
      if (secretKey) break
    }
    if (secretKey) log.info('Reusing existing Secret API key from env.')
    else if (auth.serverApiKey) {
      secretKey = auth.serverApiKey
      log.info('Using Server API key from login.')
    } else {
      log.warn('No Server API key available from login — skipping backend secret.')
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

  if (inlineApps.length) {
    log.info(`No build step in ${inlineApps.map((a) => a.rel).join(', ')} — the public key goes in the code, not a .env file.`)
  }

  return { needsDotenv, inline: inlineApps.length ? { publicKey, region } : undefined }
}
