import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { serializeSubdomainError, type SubdomainErrorKind } from '../api/subdomain-errors.js'
import {
  normalizeHostname,
  SubdomainsService,
  type DnsRecord,
  type Subdomain,
  type SubdomainListItem,
  type SubdomainStatus,
} from '../api/subdomains.js'
import { VERSION } from '../version.js'

// The wizard's agent has no shell, so `fingerprint subdomains` is exposed to it as in-process MCP
// tools backed by the same service. Authentication stays host-side: the model never sees a key.
export const FINGERPRINT_MCP_SERVER_NAME = 'fingerprint'
const TOOL_NAMES = ['list_subdomains', 'get_subdomain', 'create_subdomain', 'verify_subdomain'] as const
export const SUBDOMAIN_TOOL_NAMES = TOOL_NAMES.map((name) => `mcp__${FINGERPRINT_MCP_SERVER_NAME}__${name}`)

// What the agent did with subdomains, so the CLI can report the run honestly: a pending subdomain
// is not a finished step, and a failed create is not a success.
export interface SeenSubdomain {
  id: string
  hostname: string
  status: SubdomainStatus
  // Empty when the agent only listed: a list entry carries the status but not the records.
  pendingRecords: Pick<DnsRecord, 'type' | 'host' | 'value' | 'status'>[]
  recordsKnown: boolean
}

type Service = Pick<SubdomainsService, 'list' | 'get' | 'create' | 'verify'>

export interface SubdomainFailure {
  tool: string
  kind: SubdomainErrorKind
  message: string
}

// `hostname` is the subdomain the user asked for, when known: a list entry matching it counts as
// having seen the subdomain, so a run that only listed is still judged by its status.
export function createSubdomainsMcpServer(service: Service = new SubdomainsService(), hostname?: string) {
  const wanted = hostname ? normalizeHostname(hostname) : undefined
  let seen: SeenSubdomain | undefined
  let failure: SubdomainFailure | undefined
  let mutated = false
  const observe = (subdomain: Subdomain) => {
    failure = undefined
    const records = [subdomain.dns_records.verification, ...subdomain.dns_records.routing, subdomain.dns_records.caa]
    seen = {
      id: subdomain.id,
      hostname: subdomain.subdomain,
      status: subdomain.status,
      pendingRecords: records
        .filter((record): record is DnsRecord => Boolean(record) && record!.status !== 'validated')
        .map(({ type, host, value, status }) => ({ type, host, value, status })),
      recordsKnown: true,
    }
    return { subdomain: safeSubdomain(subdomain) }
  }
  const observeList = (items: SubdomainListItem[]) => {
    const match = wanted && items.find((item) => normalizeHostname(item.subdomain) === wanted)
    if (match && (!seen || seen.id === match.id)) {
      failure = undefined
      seen = { id: match.id, hostname: match.subdomain, status: match.status, pendingRecords: [], recordsKnown: false }
    }
    return { subdomains: items.map(safeListItem) }
  }
  const id = z.string().trim().min(1).describe('Subdomain id, as returned by list_subdomains')
  const run = async (toolName: string, operation: () => Promise<Record<string, unknown>>) => {
    try {
      return result(await operation())
    } catch (error) {
      const serialized = serializeSubdomainError(error)
      failure = { tool: toolName, kind: serialized.kind, message: serialized.message }
      return result({ error: serialized }, true)
    }
  }
  const mutate = async (toolName: string, operation: () => Promise<Record<string, unknown>>) => {
    mutated = true
    return run(toolName, operation)
  }

  const tools = [
    tool(
      'list_subdomains',
      'Lists the custom subdomains in the workspace with their status. Call it before creating one.',
      {},
      () => run('list_subdomains', async () => observeList(await service.list()))
    ),
    tool('get_subdomain', 'Gets one custom subdomain with its status and DNS records.', { id }, ({ id }) =>
      run('get_subdomain', async () => observe(await service.get(id)))
    ),
    tool(
      'create_subdomain',
      'Creates a custom subdomain and returns the DNS records the user must add.',
      { hostname: z.string().trim().min(1).describe('Fully qualified hostname, e.g. metrics.example.com') },
      ({ hostname }) => mutate('create_subdomain', async () => observe(await service.create(hostname)))
    ),
    tool(
      'verify_subdomain',
      'Checks the DNS records now and returns the refreshed subdomain. Call it once, after the records were added.',
      { id },
      ({ id }) => mutate('verify_subdomain', async () => observe(await service.verify(id)))
    ),
  ]

  return {
    server: createSdkMcpServer({ name: FINGERPRINT_MCP_SERVER_NAME, version: VERSION, tools }),
    tools,
    // The last subdomain the agent read or changed, and the last tool error not followed by a
    // successful read or change of a subdomain.
    lastSeen: () => seen,
    lastFailure: () => failure,
    // Whether the agent tried to create or verify a subdomain in this run, in any step.
    mutated: () => mutated,
  }
}

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  }
}

// Only the documented public fields go to the model; a create response also carries webhook_secret.
function safeListItem({ id, subdomain, status, created_at, updated_at }: SubdomainListItem) {
  return { id, subdomain, status, created_at, updated_at }
}

function safeSubdomain(subdomain: Subdomain) {
  const { verification, routing, caa } = subdomain.dns_records
  return {
    ...safeListItem(subdomain),
    dns_records: { verification: safeRecord(verification), routing: routing.map(safeRecord), ...(caa ? { caa: safeRecord(caa) } : {}) },
  }
}

function safeRecord({ type, host, value, status }: DnsRecord) {
  return { type, host, value, status }
}
