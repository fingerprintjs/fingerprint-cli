import { confirm, input, select } from '@inquirer/prompts'
import { serializeSubdomainError } from '../api/subdomain-errors.js'
import { normalizeHostname, SubdomainsService, type DnsRecord, type Subdomain, type SubdomainStatus } from '../api/subdomains.js'
import { isCi } from '../utils/ci.js'
import { CLOUDFLARE_DNS_ONLY_HINT, dnsRecordLines, dnsRecords, pendingDnsRecords } from '../utils/dns-records.js'
import { isVerbose } from '../utils/verbose.js'
import { log } from './log.js'
import { Spinner } from './spinner.js'
import { provisionActiveSubdomainEndpoint } from './provision.js'
import { clearPendingSubdomainSetup, savePendingSubdomainSetup } from './subdomain-setups.js'
import type { createSubdomainsMcpServer, SeenSubdomain, SubdomainFailure } from './subdomains-mcp.js'
import type { IntegrateOutcome } from './runner.js'

// The custom subdomain step, host-side. The CLI owns the hostname, the DNS wait, the resume and
// the finish; the agent runs only to create the subdomain (following the skill) and, once it is
// active, to point the app at it. Between those, checking DNS is an API call, not a model call.

// What the agent is asked to do in its run: create the subdomain, or point the app at it.
export type SubdomainStepPurpose = 'create' | 'configure'
type ApplyStep = (root: string, hostname: string, purpose: SubdomainStepPurpose) => Promise<IntegrateOutcome>

// The subdomain step needs a hostname the agent must not guess, so the CLI asks before the run.
export async function askSubdomainHostname(): Promise<string> {
  const hostname = await input({
    message: 'Custom subdomain to use (a subdomain of the site, e.g. metrics.yourdomain.com):',
    validate: (value) => (value.trim() ? true : 'Enter a hostname.'),
  })
  return normalizeHostname(hostname)
}

export async function askResumeSubdomain(hostname: string): Promise<boolean> {
  log.line()
  return confirm({ message: `Resume the custom subdomain setup for ${hostname}?`, default: true })
}

export async function runSubdomainStep(root: string, hostname: string, applyStep: ApplyStep): Promise<IntegrateOutcome> {
  savePendingSubdomainSetup(root, hostname)
  const service = new SubdomainsService()
  let current = await findSubdomain(service, hostname)
  if (!current) {
    // The agent creates it. Whatever its run reported, the API decides whether it exists now.
    const outcome = await applyStep(root, hostname, 'create')
    if (outcome === 'failed') return outcome
    current = await findSubdomain(service, hostname)
    if (!current) {
      log.error(`${hostname} was not created. Run the step again, or create it with: fingerprint subdomains create ${hostname}`)
      process.exitCode = 1
      return 'failed'
    }
  }

  let explained = false
  while (true) {
    if (current.status === 'active') {
      const outcome = await applyStep(root, hostname, 'configure')
      if (outcome === 'completed') finishSubdomainSetup(root, hostname)
      return outcome
    }
    if (current.status === 'failed' || current.status === 'timed_out') return reportTerminalStatus(hostname, current.status)
    if (isCi()) {
      const pending = pendingDnsRecords(current)
      if (pending.length) reportPending(hostname, pending)
      else log.info(`${hostname}: DNS records are validated. Certificate issuance is still in progress.`)
      log.info(resumeHint(hostname))
      return 'waiting'
    }

    // The user adds the records at their provider, then asks for a check; the check itself waits
    // for propagation with a live line. Nothing happens until they ask.
    if (!explained) {
      log.line()
      log.info('Add the records at your DNS provider, then check. Propagation usually takes a few minutes.')
      explained = true
    }
    let choice: 'check' | 'show' | 'later'
    do {
      log.line()
      choice = await select({
        message: `${hostname} is waiting for its DNS records. What's next?`,
        choices: [
          { name: 'Check the DNS records now', value: 'check' },
          { name: 'Show the DNS records again', value: 'show' },
          { name: `Finish later (resume: fingerprint integrate --subdomain ${hostname})`, value: 'later' },
        ],
      })
      if (choice === 'show') reportPending(hostname, dnsRecords(current), { heading: `DNS records for ${hostname}:` })
    } while (choice === 'show')
    if (choice === 'later') return 'waiting'

    current = await waitForDns(service, current)
    if (current.status === 'pending') {
      log.warn(
        `${hostname} is not active after ${Math.round(dnsWaitMs() / 60_000)} minutes. Check that the records match exactly and, on Cloudflare, that they are DNS only (proxying off).`
      )
    }
  }
}

// What the agent's subdomain work means for the run it just did. Returns the outcome that ends
// the step, or undefined when the normal completion path applies (active, or nothing touched,
// e.g. the user chose a proxy integration instead).
export function settleAgentSubdomainWork(
  root: string,
  server: ReturnType<typeof createSubdomainsMcpServer>,
  options: { inSubdomainStep: boolean; beforeStatus: () => void }
): IntegrateOutcome | undefined {
  const seen = server.lastSeen()
  const failure = server.lastFailure()
  if (failure || seen?.status !== 'active') options.beforeStatus()
  const outcome = judge(seen, failure)
  if (outcome === 'waiting' && seen) savePendingSubdomainSetup(root, seen.hostname)
  if (outcome) return outcome
  // Active outside the subdomain step (the agent verified it while doing something else). Inside
  // the step, runSubdomainStep finishes once the agent's run completes.
  if (seen?.status === 'active' && !options.inSubdomainStep) finishSubdomainSetup(root, seen.hostname)
  return undefined
}

function judge(seen: SeenSubdomain | undefined, failure: SubdomainFailure | undefined): IntegrateOutcome | undefined {
  if (failure) {
    log.error(`Custom subdomain setup failed: ${failure.message}${isVerbose() ? ` (${failure.tool}: ${failure.kind})` : ''}`)
    process.exitCode = 1
    return 'failed'
  }
  if (!seen || seen.status === 'active') return undefined
  if (seen.status === 'pending') {
    if (seen.pendingRecords.length) reportPending(seen.hostname, seen.pendingRecords)
    else if (!seen.recordsKnown) log.info(`${seen.hostname} is still pending — see its DNS records with: fingerprint subdomains get ${seen.hostname}`)
    else log.info(`${seen.hostname}: DNS records are validated. Certificate issuance is still in progress.`)
    if (isCi()) log.info(resumeHint(seen.hostname))
    return 'waiting'
  }
  return reportTerminalStatus(seen.hostname, seen.status)
}

// The one place a subdomain setup is completed: the endpoint variable is written, host-side, like
// the other keys, and the project stops being "unfinished". The agent has already pointed the app
// at the variable. When there is nothing the CLI can write to (no frontend, or no env convention)
// the user is told the one manual step; resuming could not do more, so the reference goes too.
function finishSubdomainSetup(root: string, hostname: string): void {
  const result = provisionActiveSubdomainEndpoint(root, hostname)
  if (result.outcome === 'configured') {
    if (result.updated) log.success(`Wrote ${result.envVar} → ${result.envFile}`)
    else log.info(`${result.envVar} already set in ${result.envFile}.`)
  } else if (result.outcome === 'no_frontend') {
    log.warn(`No frontend detected — set endpoints to https://${hostname} in the provider options manually.`)
  } else {
    log.warn(`No env convention for ${result.framework ?? 'this frontend'} — set endpoints to https://${hostname} in the provider options manually.`)
  }
  clearPendingSubdomainSetup(root)
}

async function findSubdomain(service: SubdomainsService, hostname: string): Promise<Subdomain | undefined> {
  const found = await service.findByHostname(hostname)
  if (found.outcome === 'not_found') return undefined
  if (found.outcome === 'ambiguous') throw new Error(`Several subdomains match ${hostname}; pick one with: fingerprint subdomains list`)
  return service.get(found.subdomain.id)
}

// Overridable so tests do not wait; not documented as user options.
const dnsWaitMs = () => Number(process.env.FINGERPRINT_DNS_WAIT_MS ?? 300_000)
const dnsPollMs = () => Number(process.env.FINGERPRINT_DNS_POLL_MS ?? 10_000)

// One verify (the API allows one per minute), then read the status until it settles or the wait
// runs out. Running out is not a failure: DNS propagation is outside anyone's control here. A live
// line shows what is being waited for; without a TTY, one plain line per change instead.
async function waitForDns(service: SubdomainsService, current: Subdomain): Promise<Subdomain> {
  const spinner = process.stdout.isTTY && !isCi() ? new Spinner() : null
  const started = Date.now()
  let shown = ''
  const show = (subdomain: Subdomain) => {
    if (subdomain.status !== 'pending') return
    const records = dnsRecords(subdomain)
    const validated = records.filter((record) => record.status === 'validated').length
    const progress =
      validated < records.length
        ? `Waiting for DNS propagation · ${validated} of ${records.length} records validated`
        : 'DNS records validated · waiting for the certificate'
    if (spinner) spinner.setMessage(`${progress} · ${elapsed(started)}`)
    else if (progress !== shown) log.info(progress)
    shown = progress
  }

  let latest = current
  try {
    latest = await service.verify(current.id)
  } catch (error) {
    if (serializeSubdomainError(error).kind !== 'rate_limited') throw error
  }
  spinner?.start('Waiting for DNS propagation')
  show(latest)
  const deadline = Date.now() + dnsWaitMs()
  try {
    while (latest.status === 'pending' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(dnsPollMs(), Math.max(0, deadline - Date.now()))))
      latest = await service.get(current.id)
      show(latest)
    }
  } finally {
    spinner?.stop()
  }
  if (latest.status === 'active') log.success(`${latest.subdomain} is active.`)
  return latest
}

function elapsed(since: number): string {
  const seconds = Math.round((Date.now() - since) / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

// The single way DNS records are presented in the wizard: heading, records, Cloudflare hint.
function reportPending(
  hostname: string,
  records: Pick<DnsRecord, 'type' | 'host' | 'value' | 'status'>[],
  options: { heading?: string; propagationNote?: boolean } = {}
): void {
  log.info(options.heading ?? `${hostname} is waiting for these DNS records:`)
  for (const record of records) for (const line of dnsRecordLines(record)) log.info(`  ${line}`)
  log.info(options.propagationNote ? `${CLOUDFLARE_DNS_ONLY_HINT} Propagation can take a few minutes.` : CLOUDFLARE_DNS_ONLY_HINT)
}

// `failed` needs support; `timed_out` is recoverable by deleting and creating again, so it is
// reported as waiting rather than as an error of this run.
function reportTerminalStatus(hostname: string, status: Extract<SubdomainStatus, 'failed' | 'timed_out'>): IntegrateOutcome {
  if (status === 'timed_out') {
    log.warn(`${hostname} timed out before its DNS records validated — delete it (fingerprint subdomains delete ${hostname}) and set it up again.`)
    return 'waiting'
  }
  log.error(`${hostname} failed — check it with: fingerprint subdomains get ${hostname}`)
  process.exitCode = 1
  return 'failed'
}

function resumeHint(hostname: string): string {
  return `Run fingerprint integrate --subdomain ${hostname} to continue later.`
}
