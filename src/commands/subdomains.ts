import { confirm } from '@inquirer/prompts'
import { Command } from 'commander'
import { ManagementApiError, type ApiViolation } from '../api/management.js'
import { apiErrorMessage, serializeSubdomainError, SubdomainError, UNAVAILABLE_MESSAGE } from '../api/subdomain-errors.js'
import { CLOUDFLARE_DNS_ONLY_HINT, dnsRecordLines, dnsRecords } from '../utils/dns-records.js'
import {
  SubdomainsService,
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

export function registerSubdomainsCommands(program: Command): void {
  const subdomains = program
    .command('subdomains')
    .description('Manage custom subdomains for the active workspace')
    .action(async function () {
      requireAuth()
      try {
        await listSubdomains({})
      } finally {
        console.log()
        this.outputHelp()
      }
    })
    .addHelpText('after', '\nExample:\n  fingerprint subdomains verify metrics.example.com')

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
    .argument('<id-or-hostname>', 'subdomain hostname or ID')
    .option('--json', 'print machine-readable JSON')
    .action((target: string, options: OutputOptions) => getSubdomain(target, options))

  subdomains
    .command('verify')
    .description('Check the DNS and certificate status of a custom subdomain')
    .argument('<id-or-hostname>', 'subdomain hostname or ID')
    .option('--json', 'print machine-readable JSON')
    .action((target: string, options: OutputOptions) => verifySubdomain(target, options))

  subdomains
    .command('delete')
    .description('Delete a custom subdomain and revoke its certificate')
    .argument('<id-or-hostname>', 'subdomain hostname or ID')
    .option('--json', 'print machine-readable JSON')
    .option('-y, --yes', 'confirm deletion without prompting')
    .action((target: string, options: DeleteOptions, command: Command) =>
      deleteSubdomain(target, { ...options, yes: options.yes || Boolean(command.optsWithGlobals().yes) })
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

async function getSubdomain(target: string, options: OutputOptions): Promise<void> {
  await runCommand(options, async (service) => {
    const id = await resolveSubdomainId(service, target)
    const subdomain = await service.get(id)
    if (options.json) return printJson({ data: subdomain })
    printSubdomain(subdomain)
  })
}

async function verifySubdomain(target: string, options: OutputOptions): Promise<void> {
  await runCommand(options, async (service) => {
    const id = await resolveSubdomainId(service, target)
    const subdomain = await service.verify(id)
    if (options.json) return printJson({ data: subdomain })
    console.log('Verification requested.\n')
    printSubdomain(subdomain)
  })
}

async function deleteSubdomain(target: string, options: DeleteOptions): Promise<void> {
  await runCommand(options, async (service) => {
    if ((isCi() || options.json) && !options.yes) {
      throw new SubdomainError(
        'confirmation_required',
        'Deleting a subdomain with --json or in non-interactive mode requires --yes.'
      )
    }

    const id = await resolveSubdomainId(service, target)
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

async function resolveSubdomainId(service: SubdomainsService, target: string): Promise<string> {
  const value = target.trim()
  if (value.startsWith('certv2_')) return value

  const result = await service.findByHostname(value)
  if (result.outcome === 'not_found') {
    throw new SubdomainError('not_found', `No custom subdomain named ${result.hostname} in this workspace.`)
  }
  if (result.outcome === 'ambiguous') {
    throw new SubdomainError(
      'ambiguous',
      `Multiple subdomains match ${result.hostname}. Use an ID instead: ${result.matches.map(({ id }) => id).join(', ')}.`
    )
  }
  return result.subdomain.id
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
    printJson({ error: serializeSubdomainError(error) })
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
    for (const line of dnsRecordLines(record)) console.log(`  ${line}`)
  }
  printNextStep(subdomain)
}

function printNextStep(subdomain: Subdomain): void {
  const hostname = subdomain.subdomain
  switch (subdomain.status) {
    case 'pending':
      if (dnsRecords(subdomain).some((record) => record.status !== 'validated')) {
        console.log('\nSetup is not complete. Add or correct the unvalidated DNS records above at your DNS provider.')
        console.log(CLOUDFLARE_DNS_ONLY_HINT)
        console.log('If you already added them, allow time for DNS propagation. Then run:')
        console.log(`  fingerprint subdomains verify ${hostname}`)
      } else {
        console.log('\nAll DNS records are validated. Setup is still in progress. Check the status later:')
        console.log(`  fingerprint subdomains get ${hostname}`)
      }
      break
    case 'active':
      console.log(`\nThe subdomain is active. You can now configure your Fingerprint integration to use ${hostname}.`)
      break
    case 'timed_out':
      console.log('\nSetup timed out. To retry, delete this subdomain and create it again:')
      console.log(`  fingerprint subdomains delete ${hostname}`)
      console.log(`  fingerprint subdomains create ${hostname}`)
      break
    case 'failed':
      console.log('\nSubdomain setup failed. Contact Fingerprint support before retrying.')
      break
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

function formatError(error: unknown): string {
  if (!(error instanceof ManagementApiError)) return error instanceof Error ? error.message : String(error)
  if (error.status === 503) return UNAVAILABLE_MESSAGE

  const violations = formatViolations(error.violations)
  const retry = error.retryAfter ? ` Retry after ${error.retryAfter}.` : ''
  return `${apiErrorMessage(error)}${violations}${retry}`
}

function formatViolations(violations?: ApiViolation[]): string {
  if (!violations?.length) return ''
  return `\n${violations.map((violation) => `${violation.property}: ${violation.message}`).join('\n')}`
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}
