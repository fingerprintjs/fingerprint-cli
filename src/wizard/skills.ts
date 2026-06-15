import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
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
const SKILLS_REPO = process.env.FINGERPRINT_SKILLS_REPO ?? 'https://github.com/sedyldz/fingerprint-skills'
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

// Clone the skills repo into the cache on first use; best-effort refresh if it's already there.
function ensureSkillsRepo(): void {
  try {
    if (existsSync(join(skillsCache, '.git'))) {
      try {
        execFileSync('git', ['-C', skillsCache, 'pull', '--ff-only', '--quiet'], { stdio: 'ignore' })
      } catch {
        // Offline or diverged — fall back to the cached copy as-is.
      }
      return
    }
    mkdirSync(dirname(skillsCache), { recursive: true })
    execFileSync('git', ['clone', '--depth', '1', '--quiet', SKILLS_REPO, skillsCache], { stdio: 'ignore' })
  } catch (e) {
    throw new Error(`Could not fetch skills from ${SKILLS_REPO} (needs git + network): ${(e as Error).message}`)
  }
}

// A detected stack maps to the concrete skills to apply.
export function skillsForMatch(skillId: string): string[] {
  if (skillId === 'react-node-express') return ['fingerprint-react', 'fingerprint-node']
  return [skillId]
}

export function skillMeta(id: string): SkillMeta {
  const meta = JSON.parse(readFileSync(join(skillsDir(), id, 'skill.json'), 'utf8'))
  return { id, role: meta.role, packages: meta.packages ?? [] }
}

// Install skills into the target repo's .claude/skills/ so the agent loads them on demand
// (progressive disclosure) instead of us injecting their full text into every prompt.
export function installSkills(root: string, ids: string[]): void {
  for (const id of ids) {
    const src = join(skillsDir(), id)
    if (!existsSync(join(src, 'SKILL.md'))) throw new Error(`Skill "${id}" not found in ${skillsDir()}`)
    const dest = join(root, '.claude', 'skills', id)
    mkdirSync(dest, { recursive: true })
    cpSync(src, dest, { recursive: true })
  }
}
