import { ManagementClient } from './management.js'

export type SubdomainStatus = 'pending' | 'active' | 'timed_out' | 'failed'
export type DnsRecordStatus = 'pending_validation' | 'validated' | 'failed'

export interface DnsRecord {
  type: string
  host: string
  value: string
  status: DnsRecordStatus
  [key: string]: unknown
}

export interface SubdomainListItem {
  id: string
  subdomain: string
  status: SubdomainStatus
  created_at: string
  updated_at: string
  [key: string]: unknown
}

export interface Subdomain extends SubdomainListItem {
  webhook_url: string | null
  dns_records: {
    verification: DnsRecord
    routing: DnsRecord[]
    caa?: DnsRecord
    [key: string]: unknown
  }
}

export interface CreatedSubdomain extends Subdomain {
  webhook_secret: string | null
}

interface DataResponse<T> {
  data: T
}

interface ListResponse {
  data: SubdomainListItem[]
  metadata?: {
    pagination?: {
      next_cursor?: string | null
    }
  }
}

export type SubdomainLookupResult =
  | { outcome: 'not_found'; hostname: string }
  | { outcome: 'found'; hostname: string; subdomain: SubdomainListItem }
  | { outcome: 'ambiguous'; hostname: string; matches: SubdomainListItem[] }

const PAGE_SIZE = 100

export class SubdomainsService {
  constructor(private readonly client = new ManagementClient()) {}

  async create(hostname: string): Promise<CreatedSubdomain> {
    const response = await this.client.request<DataResponse<CreatedSubdomain>>('/subdomains', {
      method: 'POST',
      body: JSON.stringify({ subdomain: hostname }),
    })
    return response.data
  }

  async list(): Promise<SubdomainListItem[]> {
    const subdomains: SubdomainListItem[] = []
    const seenCursors = new Set<string>()
    let cursor: string | null = null

    do {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
      if (cursor) query.set('cursor', cursor)

      const response = await this.client.request<ListResponse>(`/subdomains?${query}`)
      subdomains.push(...response.data)

      cursor = response.metadata?.pagination?.next_cursor ?? null
      if (cursor && seenCursors.has(cursor)) {
        throw new Error('Management API returned a repeated subdomain pagination cursor')
      }
      if (cursor) seenCursors.add(cursor)
    } while (cursor)

    return subdomains
  }

  async get(id: string): Promise<Subdomain> {
    const response = await this.client.request<DataResponse<Subdomain>>(`/subdomains/${encodeURIComponent(id)}`)
    return response.data
  }

  async verify(id: string): Promise<Subdomain> {
    const path = `/subdomains/${encodeURIComponent(id)}`
    await this.client.request<DataResponse<Subdomain>>(`${path}/verify`, { method: 'POST' })
    return this.get(id)
  }

  async delete(id: string): Promise<void> {
    await this.client.request<void>(`/subdomains/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async findByHostname(hostname: string): Promise<SubdomainLookupResult> {
    const normalized = normalizeHostname(hostname)
    const matches = (await this.list()).filter((item) => normalizeHostname(item.subdomain) === normalized)

    if (matches.length === 0) return { outcome: 'not_found', hostname: normalized }
    if (matches.length === 1) return { outcome: 'found', hostname: normalized, subdomain: matches[0] }
    return { outcome: 'ambiguous', hostname: normalized, matches }
  }
}

export function normalizeHostname(hostname: string): string {
  return hostname.trim().replace(/\.$/, '').toLowerCase()
}
