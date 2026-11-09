import { homedir } from 'node:os'

type Failure = { code: string; message?: string }

let failure: Failure | undefined

// A thrown error is reported on its own. Any path that handles its error and ends the run with
// `process.exitCode = 1` must call this first, or the run reports `error_code: unknown` with no message.
export function markFailure(code: string, detail?: unknown): void {
  if (failure) {
    return
  }
  const text = detail instanceof Error ? withCauses(detail) : typeof detail === 'string' ? detail : undefined
  const message = text && withoutHome(text)
  failure = message ? { code, message } : { code }
}

// The user-facing message says what failed; the cause chain (a fetch's ECONNRESET, an HTTP status)
// says why, and is the part a report can't be diagnosed without.
function withCauses(err: Error): string {
  const parts = [err.message]
  let cause: unknown = err.cause
  for (let depth = 0; cause !== undefined && depth < 3; depth++) {
    if (cause instanceof Error) {
      const code = (cause as NodeJS.ErrnoException).code
      parts.push(code && !cause.message.includes(code) ? `${code}: ${cause.message}` : cause.message)
      cause = cause.cause
    } else {
      parts.push(String(cause))
      break
    }
  }
  return parts.join(' — cause: ')
}

function withoutHome(text: string): string {
  const home = homedir()
  return home.length > 1 ? text.replaceAll(home, '~') : text
}

export function runFailure(): Failure | undefined {
  return failure
}
