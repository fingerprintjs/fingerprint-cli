import { getAuthState } from '../auth/tokenStore.js'
import { NotAuthenticatedError } from '../auth/notAuthenticated.js'

export function requireAuth() {
  const auth = getAuthState()
  if (!auth?.managementApiKey) throw new NotAuthenticatedError('Not logged in. Run: fingerprint login')
  return auth
}
