import { homedir } from 'node:os'

type Failure = { code: string; message?: string }

let failure: Failure | undefined

// A thrown error is reported on its own. Any path that handles its error and ends the run with
// `process.exitCode = 1` must call this first, or the run reports `error_code: unknown` with no message.
export function markFailure(code: string, detail?: unknown): void {
  if (failure) {
    return
  }
  const text = detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : undefined
  const message = text && withoutHome(text)
  failure = message ? { code, message } : { code }
}

function withoutHome(text: string): string {
  const home = homedir()
  return home.length > 1 ? text.replaceAll(home, '~') : text
}

export function runFailure(): Failure | undefined {
  return failure
}

export function resetFailureForTests(): void {
  failure = undefined
}
