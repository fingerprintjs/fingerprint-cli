import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface WizardState {
  phase: 'analyzed' | 'applied'
  completedSteps: string[]
  skillsApplied: string[]
  updatedAt: string
}

function statePath(root: string): string {
  return join(root, '.fingerprint', 'state.json')
}

export function loadState(root: string): WizardState | null {
  const p = statePath(root)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as WizardState
  } catch {
    return null
  }
}

export function saveState(root: string, state: Omit<WizardState, 'updatedAt'>): void {
  mkdirSync(join(root, '.fingerprint'), { recursive: true })
  const full: WizardState = { ...state, updatedAt: new Date().toISOString() }
  writeFileSync(statePath(root), JSON.stringify(full, null, 2))
}
