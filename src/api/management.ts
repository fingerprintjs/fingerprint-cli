import { readFileSync } from 'node:fs'
import { getAuthState } from '../auth/tokenStore.js'
import { resolveConfig } from '../config/config.js'
import { debugLog } from '../utils/log-file.js'

// Required by the Management API (see fingerprint-mcp-server).
const API_VERSION = '2025-11-20'

// `../../package.json` resolves from both `src/api` and `dist/api`.
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const USER_AGENT = `fingerprint-cli/${packageVersion()}`

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

export class ManagementClient {
  private readonly key: string
  private readonly baseUrl: string
  private readonly anonymous: boolean

  // `anonymous` omits the Authorization header entirely: an empty `Bearer ` reads as a malformed
  // token, not as "no caller".
  constructor(opts: { managementApiKey?: string; managementApiUrl?: string; anonymous?: boolean } = {}) {
    const auth = getAuthState()
    this.key = opts.managementApiKey ?? auth?.managementApiKey ?? ''
    this.baseUrl = opts.managementApiUrl ?? auth?.managementApiUrl ?? resolveConfig().managementApiUrl
    this.anonymous = opts.anonymous ?? false
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(path, this.baseUrl)
    let res: Response
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Version': API_VERSION,
          ...(this.anonymous ? {} : { Authorization: `Bearer ${this.key}` }),
          // Signals the CLI on the keyless routes, alongside the User-Agent.
          'X-Fingerprint-Client': 'cli',
          'User-Agent': USER_AGENT,
          ...(init.headers ?? {}),
        },
      })
    } catch (e) {
      // fetch rejects with a bare `TypeError: fetch failed`; name the host so the error is actionable.
      debugLog(`Management API request to ${url.href} failed: ${e instanceof Error ? e.message : String(e)}`)
      throw new ManagementApiError(`Couldn’t reach the Management API at ${url.origin}. Check your connection.`)
    }

    if (res.status === 204) return null as T

    const body = (await res.json().catch(() => ({}))) as ApiErrorBody | T
    if (!res.ok) {
      const err = (body as ApiErrorBody)?.error
      throw new ManagementApiError(err?.message ?? 'Management API request failed', res.status, err?.code)
    }
    return body as T
  }
}
