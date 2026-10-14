export class CodedError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'CodedError'
  }
}

export function errorCode(err: unknown): string {
  if (err instanceof CodedError) return err.code
  if (!(err instanceof Error)) return 'unknown'
  if (err.name === 'ExitPromptError') return 'cancelled'
  if (err.name === 'Error') return 'unknown'
  const name = err.name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
  return `unknown_${name}`.slice(0, 64)
}
