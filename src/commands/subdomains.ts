import { confirm } from '@inquirer/prompts'
import { Command } from 'commander'
import { ManagementApiError, type ApiViolation } from '../api/management.js'
import {
  SubdomainsService,
  type DnsRecord,
  type Subdomain,
  type SubdomainListItem,
} from '../api/subdomains.js'
import { isCi } from '../utils/ci.js'
import { requireAuth } from '../utils/session.js'

interface OutputOptions {
  json?: boolean
}

interface DeleteOptions extends OutputOptions {
  yes?: boolean
}

type ErrorKind =
  | 'invalid_subdomain'
  | 'duplicate'
  | 'limit_reached'
  | 'rate_limited'
  | 'not_found'
  | 'confirmation_required'
  | 'api_error'

class SubdomainCommandError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'SubdomainCommandError'
  }
}

export function registerSubdomainsCommands(program: Command): void {
  const subdomains = program
    .command('subdomains')
    .description('Manage custom subdomains for the active workspace')
    .action(function () {
      this.outputHelp()
    })

  subdomains
    .command('create')
    .description('Register a custom subdomain')
    .argument('<hostname>', 'fully-qualified subdomain hostname')
    .option('--json', 'print machine-readable JSON')
    .action((hostname: string, options: OutputOptions) => createSubdomain(hostname, options))

  subdomains
    .command('list')
    .description('List custom subdomains')
    .option('--json', 'print machine-readable JSON')
    .action((options: OutputOptions) => listSubdomains(options))

  subdomains
    .command('get')
    .description('Get a custom subdomain')
    .argument('<id>', 'subdomain ID')
    .option('--json', 'print machine-readable JSON')
    .action((id: string, options: OutputOptions) => getSubdomain(id, options))

  subdomains
    .command('verify')
    .description('Check the DNS and certificate status of a custom subdomain')
    .argument('<id>', 'subdomain ID')
    .option('--json', 'print machine-readable JSON')
    .action((id: string, options: OutputOptions) => verifySubdomain(id, options))

  subdomains
    .command('delete')
    .description('Delete a custom subdomain and revoke its certificate')
    .argument('<id>', 'subdomain ID')
    .option('--json', 'print machine-readable JSON')
    .option('-y, --yes', 'confirm deletion without prompting')
    .action((id: string, options: DeleteOptions, command: Command) =>
      deleteSubdomain(id, { ...options, yes: options.yes || Boolean(command.optsWithGlobals().yes) })
    )
}

async function createSubdomain(hostname: string, options: OutputOptions): Promise<void> {
  await runCommand(options, async (service) => {
    const subdomain = await service.create(hostname)
    if (options.json) return printJson({ data: subdomain })
    console.log('Created custom subdomain.\n')
    printSubdomain(subdomain)
  })
}

async function listSubdomains(options: OutputOptions): Promise<void> {
  await runCommand(options, async (service) => {
    const subdomains = await service.list()
    if (options.json) return printJson({ data: subdomains })
    printSubdomainList(subdomains)
  })
}

async function getSubdomain(id: string, options: OutputOptions): Promise<void> {
  await runCommand(options, async (service) => {
    const subdomain = await service.get(id)
    if (options.json) return printJson({ data: subdomain })
    printSubdomain(subdomain)
  })
}

async function verifySubdomain(id: string, options: OutputOptions): Promise<void> {
  await runCommand(options, async (service) => {
    const subdomain = await service.verify(id)
    if (options.json) return printJson({ data: subdomain })
    console.log('Verification requested.\n')
    printSubdomain(subdomain)
  })
}

async function deleteSubdomain(id: string, options: DeleteOptions): Promise<void> {
  await runCommand(options, async (service) => {
    if ((isCi() || options.json) && !options.yes) {
      throw new SubdomainCommandError(
        'confirmation_required',
        'Deleting a subdomain with --json or in non-interactive mode requires --yes.'
      )
    }

    const subdomain = await service.get(id)
    if (!options.yes) {
      const approved = await confirm({
        message: `Delete ${subdomain.subdomain} (${subdomain.id}) and revoke its certificate?`,
        default: false,
      })
      if (!approved) {
        console.log('Deletion cancelled.')
        return
      }
    }

    await service.delete(id)
    if (options.json) return printJson({ data: { id: subdomain.id, deleted: true } })
    console.log(`Deleted ${subdomain.subdomain} (${subdomain.id}).`)
  })
}

async function runCommand(
  options: OutputOptions,
  action: (service: SubdomainsService) => Promise<void>
): Promise<void> {
  try {
    requireAuth()
    await action(new SubdomainsService())
  } catch (error) {
    if (!options.json) throw new Error(formatError(error))
    printJson({ error: serializeError(error) })
    process.exitCode = 1
  }
}

function printSubdomain(subdomain: Subdomain): void {
  printFields([
    ['Subdomain', subdomain.subdomain],
    ['ID', subdomain.id],
    ['Status', subdomain.status],
    ['Created', subdomain.created_at],
    ['Updated', subdomain.updated_at],
  ])

  console.log('\nDNS records')
  for (const record of dnsRecords(subdomain)) {
    console.log(`  ${record.type}  ${record.status}`)
    printFields(
      [
        ['Host', record.host],
        ['Value', record.value],
      ],
      '    '
    )
  }
}

function printSubdomainList(subdomains: SubdomainListItem[]): void {
  if (subdomains.length === 0) {
    console.log('No custom subdomains found.')
    return
  }

  const rows = [
    ['ID', 'SUBDOMAIN', 'STATUS', 'CREATED'],
    ...subdomains.map((item) => [item.id, item.subdomain, item.status, item.created_at]),
  ]
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)))
  for (const row of rows) {
    console.log(row.map((value, column) => value.padEnd(widths[column])).join('  ').trimEnd())
  }
}

function printFields(fields: Array<[string, string]>, indent = ''): void {
  const width = Math.max(...fields.map(([label]) => label.length))
  for (const [label, value] of fields) console.log(`${indent}${label.padEnd(width)}  ${value}`)
}

function dnsRecords(subdomain: Subdomain): DnsRecord[] {
  return [
    subdomain.dns_records.verification,
    ...subdomain.dns_records.routing,
    ...(subdomain.dns_records.caa ? [subdomain.dns_records.caa] : []),
  ]
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof SubdomainCommandError) return { kind: error.kind, message: error.message }
  if (!(error instanceof ManagementApiError)) {
    return { kind: 'api_error', message: error instanceof Error ? error.message : String(error) }
  }

  return {
    kind: errorKind(error),
    message: error.message,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.violations?.length ? { violations: error.violations } : {}),
    ...(error.retryAfter === undefined ? {} : { retry_after: error.retryAfter }),
  }
}

function formatError(error: unknown): string {
  if (!(error instanceof ManagementApiError)) return error instanceof Error ? error.message : String(error)

  const violations = formatViolations(error.violations)
  const retry = error.retryAfter ? ` Retry after ${error.retryAfter}.` : ''
  return `${error.message}${violations}${retry}`
}

function formatViolations(violations?: ApiViolation[]): string {
  if (!violations?.length) return ''
  return `\n${violations.map((violation) => `${violation.property}: ${violation.message}`).join('\n')}`
}

function errorKind(error: ManagementApiError): ErrorKind {
  // Runtime currently returns 400 for limits, while the published contract documents 409.
  if (
    (error.status === 400 || error.status === 409) &&
    /limit.*subdomains|subdomains.*limit/i.test(error.message)
  ) {
    return 'limit_reached'
  }
  if (error.status === 422) return 'invalid_subdomain'
  if (error.status === 409) return 'duplicate'
  if (error.status === 429) return 'rate_limited'
  if (error.status === 404) return 'not_found'
  return 'api_error'
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}
