export class NotAuthenticatedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotAuthenticatedError'
  }
}

let unauthenticated = false

export function markUnauthenticated(): void {
  unauthenticated = true
}

export function ranUnauthenticated(): boolean {
  return unauthenticated
}
