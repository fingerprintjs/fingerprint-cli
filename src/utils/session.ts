import { getAuthState } from '../auth/tokenStore.js'

export class NotAuthenticatedError extends Error {
  constructor() {
    super('Not logged in. Run: fingerprint login')
    this.name = 'NotAuthenticatedError'
  }
}

export function requireAuth() {
  const auth = getAuthState()
  if (!auth?.managementApiKey) throw new NotAuthenticatedError()
  return auth
}
