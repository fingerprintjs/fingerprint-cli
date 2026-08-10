import { getAuthState } from '../auth/tokenStore.js'
import { resolveConfig } from '../config/config.js'

// Public Management API version header — required by the API (see fingerprint-mcp-server).
const API_VERSION = '2025-11-20'

interface ApiErrorBody {
  error?: { message?: string; code?: string }
}

export class ManagementApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string
  ) {
    super(message)
    this.name = 'ManagementApiError'
  }
}

// Thin client for the public Management API (management-api.fpjs.io). Authenticates with the
// workspace-scoped Management API key minted during browser login; the key already carries the
// workspace scope, so callers never pass a workspace/subscription id. Responses are wrapped in a
// `{ data }` envelope — callers read `.data`.
export class ManagementClient {
  private readonly key: string
  private readonly baseUrl: string

  constructor(opts: { managementApiKey?: string; managementApiUrl?: string } = {}) {
    const auth = getAuthState()
    this.key = opts.managementApiKey ?? auth?.managementApiKey ?? ''
    this.baseUrl = opts.managementApiUrl ?? auth?.managementApiUrl ?? resolveConfig().managementApiUrl
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Version': API_VERSION,
        Authorization: `Bearer ${this.key}`,
        'User-Agent': 'fingerprint-cli/0.0.2',
        ...(init.headers ?? {}),
      },
    })

    if (res.status === 204) return null as T

    const body = (await res.json().catch(() => ({}))) as ApiErrorBody | T
    if (!res.ok) {
      const err = (body as ApiErrorBody)?.error
      throw new ManagementApiError(err?.message ?? 'Management API request failed', res.status, err?.code)
    }
    return body as T
  }
}
