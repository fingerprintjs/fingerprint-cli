import { resolveConfig } from '../config/config.js'

interface ApiErrorDetails {
  code?: string
  message?: string
  param?: string
}

interface Envelope<T> {
  ok: boolean
  data: T
  error?: ApiErrorDetails
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly param?: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// Minimal client for the private mgmt-api. The CLI holds no dashboard session, so this is only used
// for the one unauthenticated call in the browser-login flow: polling for the minted workspace
// Management API key (GET /sso/cli-auth-poll?hash=<hash>). All other work goes through ManagementClient.
export class ApiClient {
  private apiUrl: string

  constructor(apiUrl?: string) {
    this.apiUrl = apiUrl ?? resolveConfig().apiUrl
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'fingerprint-cli/0.0.2',
      'X-Fingerprint-Client': 'cli',
    }

    const res = await fetch(new URL(path, this.apiUrl), { ...init, headers })
    if (res.status === 204) return null as T

    const json = (await res.json().catch(() => ({}))) as Envelope<T> | T
    if (!res.ok) {
      const e = (json as Envelope<T>)?.error
      throw new ApiError(e?.message ?? 'Request failed', res.status, e?.code, e?.param)
    }

    if (typeof json === 'object' && json !== null && 'ok' in json) {
      const env = json as Envelope<T>
      if (env.ok === false) {
        throw new ApiError(env.error?.message ?? 'Request failed', undefined, env.error?.code, env.error?.param)
      }
      return env.data
    }

    return json as T
  }
}
