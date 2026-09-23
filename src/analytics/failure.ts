type Failure = { code: string; message?: string }

let failure: Failure | undefined

export function markFailure(code: string, detail?: unknown): void {
  if (failure) {
    return
  }
  const message = detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : undefined
  failure = message ? { code, message } : { code }
}

export function runFailure(): Failure | undefined {
  return failure
}

export function resetFailureForTests(): void {
  failure = undefined
}
