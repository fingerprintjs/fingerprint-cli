import { getAuthState } from '../auth/tokenStore.js'

export function requireAuth() {
  const auth = getAuthState()
  if (!auth?.managementApiKey) throw new Error('Not logged in. Run: fingerprint login')
  return auth
}
