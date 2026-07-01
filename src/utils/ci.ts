// Non-interactive (CI/headless) context. Seeded once from global flags in index.ts, then read
// by prompts and confirmations so they fail fast or auto-proceed instead of blocking on stdin.
interface CiContext {
  ci: boolean
  // When true, "are you sure?" confirmations proceed without asking.
  yes: boolean
}

let ctx: CiContext = { ci: false, yes: false }

export function setCiContext(next: CiContext): void {
  ctx = next
}

export function isCi(): boolean {
  return ctx.ci
}

export function autoYes(): boolean {
  return ctx.yes
}
