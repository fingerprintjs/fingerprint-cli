import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { serializeSubdomainError } from '../commands/subdomains.js'
import {
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

// The last subdomain the agent read or changed, so the CLI can report the run honestly: a pending
// subdomain is not a finished step.
export interface SeenSubdomain {
  id: string
  hostname: string
  status: SubdomainStatus
  pendingRecords: Pick<DnsRecord, 'type' | 'host' | 'value'>[]
}

type Service = Pick<SubdomainsService, 'list' | 'get' | 'create' | 'verify'>

export function createSubdomainsMcpServer(service: Service = new SubdomainsService()) {
  let seen: SeenSubdomain | undefined
  const observe = (subdomain: Subdomain) => {
    const records = [subdomain.dns_records.verification, ...subdomain.dns_records.routing, subdomain.dns_records.caa]
    seen = {
      id: subdomain.id,
      hostname: subdomain.subdomain,
      status: subdomain.status,
      pendingRecords: records
        .filter((record): record is DnsRecord => Boolean(record) && record!.status !== 'validated')
        .map(({ type, host, value }) => ({ type, host, value })),
    }
    return { subdomain: safeSubdomain(subdomain) }
  }
  const id = z.string().trim().min(1).describe('Subdomain id, as returned by list_subdomains')

  const tools = [
    tool(
      'list_subdomains',
      'Lists the custom subdomains in the workspace with their status. Call it before creating one.',
      {},
      () => run(async () => ({ subdomains: (await service.list()).map(safeListItem) }))
    ),
    tool('get_subdomain', 'Gets one custom subdomain with its status and DNS records.', { id }, ({ id }) =>
      run(async () => observe(await service.get(id)))
    ),
    tool(
      'create_subdomain',
      'Creates a custom subdomain and returns the DNS records the user must add.',
      { hostname: z.string().trim().min(1).describe('Fully qualified hostname, e.g. metrics.example.com') },
      ({ hostname }) => run(async () => observe(await service.create(hostname)))
    ),
    tool(
      'verify_subdomain',
      'Checks the DNS records now and returns the refreshed subdomain. Call it once, after the records were added.',
      { id },
      ({ id }) => run(async () => observe(await service.verify(id)))
    ),
  ]

  return {
    server: createSdkMcpServer({ name: FINGERPRINT_MCP_SERVER_NAME, version: VERSION, tools }),
    tools,
    lastSeen: () => seen,
  }
}

async function run(operation: () => Promise<Record<string, unknown>>) {
  try {
    return result(await operation())
  } catch (error) {
    return result({ error: serializeSubdomainError(error) }, true)
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
