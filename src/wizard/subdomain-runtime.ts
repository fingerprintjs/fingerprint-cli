import { confirm } from '@inquirer/prompts'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { serializeSubdomainError, subdomainErrorKind } from '../api/subdomain-errors.js'
import {
  normalizeHostname,
  SubdomainsService,
  type DnsRecord,
  type Subdomain,
  type SubdomainListItem,
  type SubdomainLookupResult,
} from '../api/subdomains.js'
import { provisionActiveSubdomainEndpoint } from './provision.js'
import {
  createSubdomainsMcpServer,
  FINGERPRINT_MCP_SERVER_NAME,
  SubdomainNeedsUserActionError,
  type SubdomainsToolService,
} from './subdomains-mcp.js'

export const CONFIGURE_SUBDOMAIN_ENDPOINT_TOOL = 'configure_subdomain_endpoint'

export type SubdomainRunOutcome = 'idle' | 'waiting' | 'active' | 'completed' | 'needs_user_action' | 'failed'

export interface SubdomainRunState {
  outcome: SubdomainRunOutcome
  subdomain?: Pick<SubdomainListItem, 'id' | 'subdomain' | 'status'>
  pendingDnsRecords?: Array<Pick<DnsRecord, 'type' | 'host' | 'value' | 'status'>>
  recreateHostname?: string
}

interface RuntimeOptions {
  root: string
  explicitHostname?: string
  headless?: boolean
  service?: SubdomainsService
  confirm?: typeof confirm
  beforePrompt?: () => void
  subdomainSetupSelected?: () => boolean
}

export function mcpToolName(name: string): string {
  return `mcp__${FINGERPRINT_MCP_SERVER_NAME}__${name}`
}

export function createSubdomainRuntime(options: RuntimeOptions) {
  const service = options.service ?? new SubdomainsService()
  const state: SubdomainRunState = { outcome: 'idle' }
  const explicitHostname = options.explicitHostname
    ? normalizeHostname(options.explicitHostname)
    : undefined
  const askForConfirmation = options.confirm ?? confirm
  let listCache: SubdomainListItem[] | undefined
  const detailCache = new Map<string, Subdomain>()
  const lookupCache = new Map<string, SubdomainLookupResult>()
  const verified = new Set<string>()
  let operationFailed = false

  const shouldTrackReads = (): boolean =>
    state.outcome !== 'idle' || options.subdomainSetupSelected?.() === true

  const observe = (subdomain: SubdomainListItem, preserveCompleted = false): void => {
    const remainsCompleted =
      preserveCompleted &&
      state.outcome === 'completed' &&
      state.subdomain?.id === subdomain.id &&
      subdomain.status === 'active'
    state.subdomain = {
      id: subdomain.id,
      subdomain: subdomain.subdomain,
      status: subdomain.status,
    }
    state.recreateHostname = undefined
    if ('dns_records' in subdomain) {
      const details = subdomain as Subdomain
      state.pendingDnsRecords = [
        details.dns_records.verification,
        ...details.dns_records.routing,
        ...(details.dns_records.caa ? [details.dns_records.caa] : []),
      ]
        .filter((record) => record.status !== 'validated')
        .map(({ type, host, value, status }) => ({ type, host, value, status }))
    }
    if (operationFailed) return
    if (remainsCompleted) return
    switch (subdomain.status) {
      case 'pending':
        state.outcome = 'waiting'
        break
      case 'active':
        state.outcome = 'active'
        break
      case 'timed_out':
        state.outcome = 'needs_user_action'
        break
      case 'failed':
        state.outcome = 'failed'
        break
    }
  }

  const needsUserAction = (message: string): never => {
    markNeedsUserAction()
    throw new SubdomainNeedsUserActionError(message)
  }

  const markNeedsUserAction = (): void => {
    if (!operationFailed) state.outcome = 'needs_user_action'
  }

  const handleOperationError = (error: unknown): void => {
    if (error instanceof SubdomainNeedsUserActionError) {
      markNeedsUserAction()
      return
    }

    const kind = subdomainErrorKind(error)
    if (kind === 'rate_limited' && state.outcome === 'waiting') return
    if (kind !== 'api_error') {
      markNeedsUserAction()
      return
    }

    operationFailed = true
    state.outcome = 'failed'
  }

  const confirmAction = async (message: string): Promise<boolean> => {
    options.beforePrompt?.()
    return askForConfirmation({ message, default: false })
  }

  const remember = <T extends Subdomain>(subdomain: T): T => {
    detailCache.set(subdomain.id, subdomain)
    if (listCache) {
      const index = listCache.findIndex((item) => item.id === subdomain.id)
      if (index >= 0) listCache[index] = subdomain
      else listCache.push(subdomain)
    }
    return subdomain
  }

  const getDetail = async (id: string): Promise<Subdomain> => {
    const cached = detailCache.get(id)
    return cached ?? remember(await service.get(id))
  }

  const findByHostname = async (hostname: string): Promise<SubdomainLookupResult> => {
    const cached = lookupCache.get(hostname)
    if (cached) return cached

    let result: SubdomainLookupResult
    if (listCache) {
      const matches = listCache.filter((item) => normalizeHostname(item.subdomain) === hostname)
      result =
        matches.length === 0
          ? { outcome: 'not_found', hostname }
          : matches.length === 1
            ? { outcome: 'found', hostname, subdomain: matches[0] }
            : { outcome: 'ambiguous', hostname, matches }
    } else {
      result = await service.findByHostname(hostname)
    }
    lookupCache.set(hostname, result)
    return result
  }

  const runtimeService: SubdomainsToolService = {
    async create(rawHostname) {
      if (state.outcome === 'idle') markNeedsUserAction()
      const requested = normalizeHostname(rawHostname)
      if (explicitHostname && requested !== explicitHostname) {
        return needsUserAction(`Use the subdomain supplied by the user: ${explicitHostname}.`)
      }
      if (options.headless && !explicitHostname) {
        return needsUserAction('A subdomain was not provided. Re-run with --subdomain <fqdn>.')
      }

      const hostname = explicitHostname ?? requested
      const existing = await findByHostname(hostname)
      if (existing.outcome === 'ambiguous') {
        const candidates = [...existing.matches]
          .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
          .map((item) => `${item.subdomain} (${item.id}, ${item.status})`)
        return needsUserAction(
          `More than one custom subdomain matches ${hostname}. Ask the user to choose one: ${candidates.join('; ')}.`
        )
      }
      if (existing.outcome === 'found') {
        const subdomain = await getDetail(existing.subdomain.id)
        observe(subdomain, true)
        return { ...subdomain, webhook_secret: null }
      }

      if (!explicitHostname && !(await confirmAction(`Create the immutable custom subdomain ${hostname}?`))) {
        return needsUserAction('The user declined to create the custom subdomain.')
      }

      const subdomain = remember(await service.create(hostname))
      lookupCache.set(hostname, { outcome: 'found', hostname, subdomain })
      observe(subdomain)
      return subdomain
    },

    async list() {
      if (shouldTrackReads() && state.outcome === 'idle') markNeedsUserAction()
      listCache ??= await service.list()
      return listCache
    },

    async get(id) {
      const subdomain = await getDetail(id)
      if (shouldTrackReads()) observe(subdomain, true)
      return subdomain
    },

    async verify(id) {
      if (state.outcome === 'idle') markNeedsUserAction()
      const current = await getDetail(id)
      observe(current, true)

      if (current.status !== 'pending') return current
      if (verified.has(id)) return current

      const targetWasSupplied = explicitHostname === normalizeHostname(current.subdomain)
      if (options.headless && !targetWasSupplied) {
        return needsUserAction('The subdomain to verify was not selected explicitly.')
      }
      if (!options.headless && !targetWasSupplied) {
        const approved = await confirmAction(`Check DNS for ${current.subdomain} (${current.id})?`)
        if (!approved) return needsUserAction('The user declined the DNS check.')
      }
      verified.add(id)
      const subdomain = remember(await service.verify(id))
      observe(subdomain)
      return subdomain
    },

    async delete(id) {
      markNeedsUserAction()
      const current = await getDetail(id)
      observe(current)
      if (options.headless) {
        return needsUserAction('Deleting a subdomain requires fresh interactive confirmation.')
      }
      const approved = await confirmAction(
        `Delete ${current.subdomain} (${current.id}) and revoke its certificate?`
      )
      if (!approved) return needsUserAction('The user declined to delete the custom subdomain.')
      await service.delete(id)
      detailCache.delete(id)
      lookupCache.delete(normalizeHostname(current.subdomain))
      if (listCache) listCache = listCache.filter((item) => item.id !== id)
      state.subdomain = undefined
      state.pendingDnsRecords = undefined
      state.recreateHostname = current.subdomain
      markNeedsUserAction()
    },
  }

  const guardRuntimeOperation = async <T>(operation: () => Promise<T>, trackOutcome = true): Promise<T> => {
    try {
      if (operationFailed) throw new Error('Custom subdomain setup already failed in this run.')
      return await operation()
    } catch (error) {
      if (trackOutcome) handleOperationError(error)
      throw error
    }
  }

  const guardedRuntimeService: SubdomainsToolService = {
    create: (hostname) => guardRuntimeOperation(() => runtimeService.create(hostname)),
    list: () => guardRuntimeOperation(() => runtimeService.list(), shouldTrackReads()),
    get: (id) => guardRuntimeOperation(() => runtimeService.get(id), shouldTrackReads()),
    verify: (id) => guardRuntimeOperation(() => runtimeService.verify(id)),
    delete: (id) => guardRuntimeOperation(() => runtimeService.delete(id)),
  }

  const configureEndpoint = tool(
    CONFIGURE_SUBDOMAIN_ENDPOINT_TOOL,
    'Configures the selected frontend to use an active custom subdomain. Call only after the API reports active.',
    { id: z.string().trim().min(1).describe('Active custom subdomain identifier') },
    async ({ id }) => {
      try {
        if (operationFailed) throw new Error('Custom subdomain setup already failed in this run.')
        if (state.outcome === 'idle') markNeedsUserAction()
        const subdomain = await getDetail(id)
        if (subdomain.status !== 'active') {
          observe(subdomain)
          return jsonResult({
            outcome: state.outcome,
            subdomain: publicIdentity(subdomain),
            message:
              subdomain.status === 'pending'
                ? 'The subdomain is still pending. Do not set endpoints yet.'
                : 'The subdomain cannot be configured in its current state.',
          })
        }

        const targetWasSupplied = explicitHostname === normalizeHostname(subdomain.subdomain)
        if (options.headless && !targetWasSupplied) {
          markNeedsUserAction()
          return needsUserActionResult(
            'The active subdomain must be selected before configuring this project.'
          )
        }
        if (
          !options.headless &&
          !targetWasSupplied &&
          !(await confirmAction(`Use ${subdomain.subdomain} (${subdomain.id}) for this project?`))
        ) {
          return needsUserAction('The user declined to configure this custom subdomain.')
        }

        observe(subdomain)
        const provisioned = provisionActiveSubdomainEndpoint(options.root, subdomain.subdomain)
        if (provisioned.outcome !== 'configured') {
          markNeedsUserAction()
          return jsonResult({
            outcome: 'needs_user_action',
            subdomain: publicIdentity(subdomain),
            reason: provisioned.outcome,
            ...(provisioned.outcome === 'unsupported' ? { framework: provisioned.framework } : {}),
          })
        }

        state.outcome = 'completed'
        return jsonResult({
          outcome: 'completed',
          subdomain: publicIdentity(subdomain),
          endpoint: provisioned.endpoint,
          env_file: provisioned.envFile,
          env_var: provisioned.envVar,
          updated: provisioned.updated,
        })
      } catch (error) {
        if (error instanceof SubdomainNeedsUserActionError) {
          markNeedsUserAction()
          return needsUserActionResult(error.message)
        }
        handleOperationError(error)
        return jsonResult({ error: serializeSubdomainError(error) }, true)
      }
    },
    {
      annotations: {
        title: 'Configure Subdomain Endpoint',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    }
  )

  return {
    server: createSubdomainsMcpServer(guardedRuntimeService, [configureEndpoint]),
    state,
  }
}

function publicIdentity(subdomain: SubdomainListItem) {
  return {
    id: subdomain.id,
    subdomain: subdomain.subdomain,
    status: subdomain.status,
  }
}

function jsonResult(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  }
}

function needsUserActionResult(message: string) {
  return jsonResult({ outcome: 'needs_user_action', message }, true)
}
