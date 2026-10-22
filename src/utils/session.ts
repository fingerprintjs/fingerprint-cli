import { getAuthState } from '../auth/tokenStore.js'
import { CodedError } from '../errors.js'

export class NotAuthenticatedError extends CodedError {
  constructor() {
    super('not_authenticated', 'Not logged in. Run: fingerprint login')
    this.name = 'NotAuthenticatedError'
  }
}

export function requireAuth() {
  const auth = getAuthState()
  if (!auth?.managementApiKey) throw new NotAuthenticatedError()
  return auth
}
