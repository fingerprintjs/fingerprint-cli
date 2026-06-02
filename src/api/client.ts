import { AuthState, getAuthState, saveAuthState } from '../auth/tokenStore.js'
import { resolveConfig } from '../config/config.js'

interface Envelope<T> { ok: boolean; data: T; error?: { code?: string; message?: string; param?: string } }

export class ApiClient {
  private state: AuthState | null
  private apiUrl: string

  constructor(apiUrl?: string) {
    this.state = getAuthState()
    this.apiUrl = apiUrl ?? this.state?.apiUrl ?? resolveConfig().apiUrl
  }

  async request<T>(path: string, init: RequestInit = {}, auth = false): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
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
      throw new Error(e?.message ?? 'Request failed')
    }

    if (typeof json === 'object' && json !== null && 'ok' in json) {
      const env = json as Envelope<T>
      if (env.ok === false) throw new Error(env.error?.message ?? 'Request failed')
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
