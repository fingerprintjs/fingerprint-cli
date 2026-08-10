import { ManagementClient } from './management.js'

// Public Management API key. `token` holds the key value; for secret keys it is only returned at
// creation. `type` is 'public' | 'secret' | 'proxy'.
interface ApiKey {
  id: string
  type: string
  status: string
  token: string | null
}

// The public (browser) key is readable any time via the list endpoint, filtered to public + enabled.
export async function fetchPublicKey(client: ManagementClient): Promise<string | undefined> {
  const res = await client.request<{ data: ApiKey[] }>('/api-keys?type=public&status=enabled&limit=100', {
    method: 'GET',
  })
  return res.data.find((k) => k.token)?.token ?? undefined
}
