import { ApiClient } from './client.js'
import { endpoints } from './endpoints.js'

// Public (browser) keys are readable from the API any time.
export async function fetchPublicKey(client: ApiClient, subscriptionId: string): Promise<string | undefined> {
  const tokens = await client.request<any[]>(endpoints.tokens(subscriptionId), { method: 'GET' }, true)
  return tokens.find((t) => t.type === 'browser')?.token
}

// Secret (api) key values are only returned at creation, so we can't re-read an existing one —
// each create counts against the workspace key limit.
export async function createSecretKey(client: ApiClient, subscriptionId: string): Promise<string> {
  const created = await client.request<any>(endpoints.tokens(subscriptionId), {
    method: 'POST',
    body: JSON.stringify({ type: 'api', name: 'CLI Secret Key' }),
  }, true)
  return created.token
}
