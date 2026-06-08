import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SkillMeta {
  id: string
  role: string
  packages: string[]
}

// Skills live in their own repo, not the CLI. Override with FINGERPRINT_SKILLS_DIR.
function skillsDir(): string {
  return process.env.FINGERPRINT_SKILLS_DIR ?? join(homedir(), 'Dev', 'fingerprint-skills')
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
