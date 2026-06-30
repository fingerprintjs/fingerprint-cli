import { AuthState, getAuthState, saveAuthState } from '../auth/tokenStore.js'
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

export class ApiClient {
  private state: AuthState | null
  private apiUrl: string

  constructor(apiUrl?: string) {
    this.state = getAuthState()
    this.apiUrl = apiUrl ?? this.state?.apiUrl ?? resolveConfig().apiUrl
  }

  async request<T>(path: string, init: RequestInit = {}, auth = false): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Lets the backend identify requests originating from this CLI.
      'X-Fingerprint-Client': 'cli',
      'X-Fingerprint-Client-Version': '0.0.2',
      // @TODO: Add signature based verification for the client
    }
    if (auth && this.state?.accessToken) headers.Authorization = `Bearer ${this.state.accessToken}`

    const res = await fetch(new URL(path, this.apiUrl), { ...init, headers })
    if (res.status === 401 && auth && this.state?.refreshToken) {
      await this.refresh()
      return this.request(path, init, auth)
    }

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

  private async refresh() {
    if (!this.state?.refreshToken) return
    const data = await this.request<{ accessToken: string; refreshToken?: string }>('/refresh_token/exchange', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: this.state.refreshToken }),
    })
    this.state = { ...this.state, ...data }
    saveAuthState(this.state)
  }
}
