import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { serializeSubdomainError } from '../api/subdomain-errors.js'
import {
  SubdomainsService,
  type DnsRecord,
  type Subdomain,
  type SubdomainListItem,
} from '../api/subdomains.js'
import { VERSION } from '../version.js'

export const FINGERPRINT_MCP_SERVER_NAME = 'fingerprint'

export const SUBDOMAIN_TOOL_NAMES = {
  create: 'create_subdomain',
  list: 'list_subdomains',
  get: 'get_subdomain',
  verify: 'verify_subdomain',
  delete: 'delete_subdomain',
} as const

export type SubdomainsToolService = Pick<SubdomainsService, 'create' | 'list' | 'get' | 'verify' | 'delete'>

export class SubdomainNeedsUserActionError extends Error {}

const idSchema = z.string().trim().min(1).describe('Custom subdomain identifier')

export function createSubdomainsTools(service: SubdomainsToolService): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      SUBDOMAIN_TOOL_NAMES.create,
      'Registers a custom subdomain and returns its status and DNS records.',
      { hostname: z.string().trim().min(1).describe('Fully-qualified subdomain hostname') },
      ({ hostname }) => runTool(async () => ({ subdomain: safeSubdomain(await service.create(hostname)) })),
      {
        annotations: {
          title: 'Create Subdomain',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      }
    ),
    tool(
      SUBDOMAIN_TOOL_NAMES.list,
      'Lists all custom subdomains in the active workspace and their current status.',
      {},
      () => runTool(async () => ({ subdomains: (await service.list()).map(safeSubdomainListItem) })),
      {
        annotations: {
          title: 'List Subdomains',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      }
    ),
    tool(
      SUBDOMAIN_TOOL_NAMES.get,
      'Gets one custom subdomain with its status and DNS records.',
      { id: idSchema },
      ({ id }) => runTool(async () => ({ subdomain: safeSubdomain(await service.get(id)) })),
      {
        annotations: {
          title: 'Get Subdomain',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      }
    ),
    tool(
      SUBDOMAIN_TOOL_NAMES.verify,
      'Triggers an on-demand DNS check and returns the refreshed custom subdomain.',
      { id: idSchema },
      ({ id }) => runTool(async () => ({ subdomain: safeSubdomain(await service.verify(id)) })),
      {
        annotations: {
          title: 'Verify Subdomain',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      }
    ),
    tool(
      SUBDOMAIN_TOOL_NAMES.delete,
      'Deletes a custom subdomain and revokes its certificate. This operation is irreversible.',
      { id: idSchema },
      ({ id }) =>
        runTool(async () => {
          await service.delete(id)
          return { id, deleted: true }
        }),
      {
        annotations: {
          title: 'Delete Subdomain',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      }
    ),
  ]
}

export function createSubdomainsMcpServer(
  service: SubdomainsToolService = new SubdomainsService(),
  extraTools: SdkMcpToolDefinition<any>[] = []
) {
  return createSdkMcpServer({
    name: FINGERPRINT_MCP_SERVER_NAME,
    version: VERSION,
    tools: [...createSubdomainsTools(service), ...extraTools],
    alwaysLoad: true,
  })
}

async function runTool(operation: () => Promise<Record<string, unknown>>) {
  try {
    return jsonResult(await operation())
  } catch (error) {
    if (error instanceof SubdomainNeedsUserActionError) {
      return jsonResult({ outcome: 'needs_user_action', message: error.message }, true)
    }
    return jsonResult({ error: serializeSubdomainError(error) }, true)
  }
}

function jsonResult(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  }
}

function safeSubdomainListItem(subdomain: SubdomainListItem) {
  return {
    id: subdomain.id,
    subdomain: subdomain.subdomain,
    status: subdomain.status,
    created_at: subdomain.created_at,
    updated_at: subdomain.updated_at,
  }
}

function safeSubdomain(subdomain: Subdomain) {
  return {
    ...safeSubdomainListItem(subdomain),
    dns_records: {
      verification: safeDnsRecord(subdomain.dns_records.verification),
      routing: subdomain.dns_records.routing.map(safeDnsRecord),
      ...(subdomain.dns_records.caa ? { caa: safeDnsRecord(subdomain.dns_records.caa) } : {}),
    },
  }
}

function safeDnsRecord(record: DnsRecord) {
  return {
    type: record.type,
    host: record.host,
    value: record.value,
    status: record.status,
  }
}
