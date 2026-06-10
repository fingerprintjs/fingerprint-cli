import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ApiClient } from '../api/client.js'
import { endpoints } from '../api/endpoints.js'
import { requireAuth } from '../utils/session.js'
import { text } from '../utils/prompt.js'
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

// Map the workspace regionCode (use1/euc1/aps1) to the JS agent region ('us'|'eu'|'ap').
const REGION_BY_CODE: Record<string, string> = { use1: 'us', euc1: 'eu', aps1: 'ap' }

async function fetchRegion(client: ApiClient, subscriptionId: string): Promise<string> {
  const subs = await client.request<any[]>(endpoints.subscriptions, { method: 'GET' }, true)
  const sub = subs.find((s) => s.id === subscriptionId)
  return REGION_BY_CODE[sub?.regionCode] ?? 'us'
}

function relevantApps(a: RepoAnalysis): DetectedApp[] {
  return a.apps.filter((x) => x.role === 'frontend' || x.role === 'backend' || x.role === 'fullstack')
}

// Public (browser) keys are readable from the API any time.
async function fetchPublicKey(client: ApiClient, subscriptionId: string): Promise<string | undefined> {
  const tokens = await client.request<any[]>(endpoints.tokens(subscriptionId), { method: 'GET' }, true)
  return tokens.find((t) => t.type === 'browser')?.token
}

// Secret (api) key values are only returned at creation, so we can't re-read an existing one —
// each create counts against the workspace key limit. Only call this when we don't already have one.
async function createSecretKey(client: ApiClient, subscriptionId: string): Promise<string> {
  const created = await client.request<any>(endpoints.tokens(subscriptionId), {
    method: 'POST',
    body: JSON.stringify({ type: 'api', name: 'CLI Secret Key' }),
  }, true)
  return created.token
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

// Provision real workspace keys into the right per-app .env files, host-side (never via the
// agent, so secrets stay out of the LLM transcript). Returns backends that need `dotenv`.
export async function provisionForRepo(root: string): Promise<DetectedApp[]> {
  const auth = requireAuth()
  if (!auth.currentSubscriptionId) throw new Error('No active workspace. Run: fingerprint workspace use <id>')
  const client = new ApiClient(auth.apiUrl)

  let apps = relevantApps(analyzeRepo(root))

  // Frontend present but nothing to hold the secret → ask where the backend is.
  const hasFrontendKey = apps.some((a) => conventionFor(a).publicVar)
  const hasSecretHolder = apps.some((a) => conventionFor(a).secretVar)
  if (hasFrontendKey && !hasSecretHolder) {
    const p = await text('No backend found in this repo. Path to your backend project (blank to skip)')
    if (p.trim()) {
      const be = relevantApps(analyzeRepo(resolve(p.trim()))).find((a) => conventionFor(a).secretVar)
      if (be) apps = [...apps, be]
      else log.warn(`No backend framework detected at ${p.trim()} — skipping the secret key.`)
    }
  }

  const publicApps = apps.filter((a) => conventionFor(a).publicVar)
  const secretApps = apps.filter((a) => conventionFor(a).secretVar)

  // The agent region must match the workspace region, or identification fails ("API key not found").
  const region = await fetchRegion(client, auth.currentSubscriptionId)
  log.info(`Workspace region: ${region}`)

  const publicKey = publicApps.length ? await fetchPublicKey(client, auth.currentSubscriptionId) : undefined
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
      secretKey = await createSecretKey(client, auth.currentSubscriptionId)
      log.info('Created Secret API key.')
    }
  }

  const needsDotenv: DetectedApp[] = []
  for (const app of apps) {
    const conv = conventionFor(app)
    const written = writeEnvFile(join(app.dir, conv.file), {
      [conv.publicVar ?? '']: conv.publicVar ? publicKey : undefined,
      [conv.secretVar ?? '']: conv.secretVar ? secretKey : undefined,
      [conv.clientRegionVar ?? '']: conv.clientRegionVar ? region : undefined,
      [conv.serverRegionVar ?? '']: conv.serverRegionVar ? region : undefined,
    })
    if (written.length) log.success(`Wrote ${written.join(', ')} → ${join(app.rel, conv.file)}`)
    if (conv.needsDotenv && conv.secretVar) needsDotenv.push(app)
  }
  return needsDotenv
}
