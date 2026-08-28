import { readFileSync } from 'node:fs'
import { getAuthState } from '../auth/tokenStore.js'
import { resolveConfig } from '../config/config.js'
import { debugLog } from '../utils/log-file.js'

// Public Management API version header — required by the API (see fingerprint-mcp-server).
const API_VERSION = '2025-11-20'

// `src/api` and `dist/api` both sit two levels under the package root, so this resolves either way.
// A hardcoded string here drifts from the published version the moment anyone forgets to bump it,
// and the Management API reads this to tell CLI traffic apart and to report which version sent an
// event.
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

// Thin client for the public Management API (management-api.fpjs.io). Authenticates with the
// workspace-scoped Management API key minted during browser login; the key already carries the
// workspace scope, so callers never pass a workspace/subscription id. Responses are wrapped in a
// `{ data }` envelope — callers read `.data`.
export class ManagementClient {
  private readonly key: string
  private readonly baseUrl: string
  private readonly anonymous: boolean

  // `anonymous` is for the handful of routes that accept no key at all. Sending `Bearer ` with an
  // empty key would be rejected as a malformed token rather than read as "no caller", so the header
  // has to be absent rather than empty.
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
          // Matched against on the routes that accept no key, alongside the User-Agent below.
          'X-Fingerprint-Client': 'cli',
          'User-Agent': USER_AGENT,
          ...(init.headers ?? {}),
        },
      })
    } catch (e) {
      // DNS/connect/TLS failures reject with Node's bare `TypeError: fetch failed`, which reaches the
      // user with no URL and nothing to act on. Name the host we couldn't reach, and keep the original
      // cause in the debug log for diagnosis.
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
