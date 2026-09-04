import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface SkillMeta {
  id: string
  role: string
  packages: string[]
}

// Skills live in their own public repo and are cloned into a local cache on first use, so a
// downloaded CLI works without any local checkout. Override the source with FINGERPRINT_SKILLS_REPO,
// or point at a local checkout with FINGERPRINT_SKILLS_DIR (for developing skills).
const SKILLS_REPO = process.env.FINGERPRINT_SKILLS_REPO ?? 'https://github.com/fingerprintjs/skills'
const skillsCache = join(homedir(), '.config', 'fingerprint', 'skills')
let ensured = false

function skillsDir(): string {
  if (process.env.FINGERPRINT_SKILLS_DIR) return process.env.FINGERPRINT_SKILLS_DIR
  if (!ensured) {
    ensureSkillsRepo()
    ensured = true
  }
  return skillsCache
}

// Cap each git call so a hung network/auth prompt can't block the wizard indefinitely.
const GIT_TIMEOUT_MS = 30_000

// Clone the skills repo into the cache on first use; best-effort refresh if it's already there.
function ensureSkillsRepo(): void {
  try {
    if (existsSync(join(skillsCache, '.git'))) {
      try {
        execFileSync('git', ['-C', skillsCache, 'pull', '--ff-only', '--quiet'], { stdio: 'ignore', timeout: GIT_TIMEOUT_MS })
      } catch {
        // Offline, diverged, or timed out — fall back to the cached copy as-is.
      }
      return
    }
    mkdirSync(dirname(skillsCache), { recursive: true })
    execFileSync('git', ['clone', '--depth', '1', '--quiet', SKILLS_REPO, skillsCache], { stdio: 'ignore', timeout: GIT_TIMEOUT_MS })
  } catch (e) {
    throw new Error(
      `Could not fetch skills from ${SKILLS_REPO} (needs git + network). ` +
        `If you're offline, set FINGERPRINT_SKILLS_DIR to a local checkout. Cause: ${(e as Error).message}`
    )
  }
}

// Skill folders live under the repo's `skills/` directory (standard Claude Code plugin layout).
function skillSrc(id: string): string {
  return join(skillsDir(), 'skills', id)
}

export function skillMeta(id: string): SkillMeta {
  const meta = JSON.parse(readFileSync(join(skillSrc(id), 'skill.json'), 'utf8'))
  return { id, role: meta.role, packages: meta.packages ?? [] }
}

// The feature skills the Get Started orchestrator dispatches to for the later checklist steps
// (proxy, rules, tagging, ...), tagged `category: "get-started"` in their skill.json. Installed
// alongside it so every step it names can actually be applied.
export function getStartedSkills(): string[] {
  const dir = join(skillsDir(), 'skills')
  return readdirSync(dir).filter((id) => {
    try {
      return JSON.parse(readFileSync(join(dir, id, 'skill.json'), 'utf8')).category === 'get-started'
    } catch {
      return false
    }
  })
}

// The skills repo is an external supply chain, and its `packages` are handed to a host-side
// `npm`/`pip install` — where a postinstall script runs arbitrary code. So never install an
// arbitrary name from a skill: allow only Fingerprint's own scoped packages plus a fixed set of
// known peer deps the skills legitimately need.
const ALLOWED_PACKAGES = new Set([
  'dotenv', // Node backends
  'python-dotenv', // Python backends
  'fingerprint-server-sdk', // Fingerprint Python server SDK (unscoped)
])

// Strip a version/tag suffix to get the bare package name. Scoped names start with '@', so a real
// version specifier is an '@' after position 0 (e.g. '@fingerprint/react@^4' -> '@fingerprint/react').
function packageName(spec: string): string {
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(0, at) : spec
}

// Throw if a skill asks to install something outside the allowlist. Called at the install chokepoint
// so a compromised/overridden skills repo can't trigger an arbitrary-package install (RCE via postinstall).
export function assertAllowedPackage(spec: string): void {
  const name = packageName(spec)
  if (name.startsWith('@fingerprint/') || ALLOWED_PACKAGES.has(name)) return
  throw new Error(
    `Refusing to install untrusted package "${spec}" from a skill. ` +
      `Only @fingerprint/* and known peers (${[...ALLOWED_PACKAGES].join(', ')}) are allowed.`
  )
}

// Install skills into the target repo's .claude/skills/ so the agent loads them on demand
// (progressive disclosure) instead of us injecting their full text into every prompt.
export function installSkills(root: string, ids: string[]): void {
  for (const id of ids) {
    const src = skillSrc(id)
    if (!existsSync(join(src, 'SKILL.md'))) throw new Error(`Skill "${id}" not found in ${skillsDir()}`)
    const dest = join(root, '.claude', 'skills', id)
    mkdirSync(dest, { recursive: true })
    cpSync(src, dest, { recursive: true })
  }
}
