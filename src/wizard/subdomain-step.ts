import { confirm, input, select } from '@inquirer/prompts'
import { serializeSubdomainError } from '../api/subdomain-errors.js'
import { normalizeHostname, SubdomainsService, type DnsRecord, type Subdomain, type SubdomainStatus } from '../api/subdomains.js'
import { isCi } from '../utils/ci.js'
import { CLOUDFLARE_DNS_ONLY_HINT, dnsRecordLines, dnsRecords, pendingDnsRecords } from '../utils/dns-records.js'
import { isVerbose } from '../utils/verbose.js'
import { log } from './log.js'
import { provisionActiveSubdomainEndpoint } from './provision.js'
import { clearPendingSubdomainSetup, savePendingSubdomainSetup } from './subdomain-setups.js'
import type { createSubdomainsMcpServer, SeenSubdomain, SubdomainFailure } from './subdomains-mcp.js'
import type { IntegrateOutcome } from './runner.js'

// The custom subdomain step, host-side. The CLI owns the hostname, the DNS wait, the resume and
// the finish; the agent runs only to create the subdomain (following the skill) and, once it is
// active, to point the app at it. Between those, checking DNS is an API call, not a model call.

type ApplyStep = (root: string, hostname: string) => Promise<IntegrateOutcome>

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
    const outcome = await applyStep(root, hostname)
    if (outcome !== 'waiting') return outcome
    current = await findSubdomain(service, hostname)
    if (!current) return 'waiting'
  }

  while (true) {
    if (current.status === 'active') {
      const outcome = await applyStep(root, hostname)
      if (outcome === 'completed') finishSubdomainSetup(root, hostname)
      return outcome
    }
    if (current.status === 'failed' || current.status === 'timed_out') return reportTerminalStatus(hostname, current.status)
    if (isCi()) {
      log.info(resumeHint(hostname))
      return 'waiting'
    }

    log.line()
    const choice = await select({
      message: `${hostname} is waiting for its DNS records. What's next?`,
      choices: [
        { name: 'Check the DNS records now', value: 'check' },
        { name: 'Show the DNS records again', value: 'show' },
        { name: `Finish later (resume: fingerprint integrate --subdomain ${hostname})`, value: 'later' },
      ],
    })
    if (choice === 'later') return 'waiting'
    if (choice === 'show') {
      reportPending(hostname, dnsRecords(current), { heading: `DNS records for ${hostname}:` })
      continue
    }
    current = await waitForDns(service, current)
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
// at the variable.
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

// One verify (the API allows one per minute), then read the status until it settles or the wait
// runs out. Running out is not a failure: DNS propagation is outside anyone's control here.
async function waitForDns(service: SubdomainsService, current: Subdomain): Promise<Subdomain> {
  // Overridable so tests do not wait; not documented as user options.
  const waitMs = Number(process.env.FINGERPRINT_DNS_WAIT_MS ?? 120_000)
  const pollMs = Number(process.env.FINGERPRINT_DNS_POLL_MS ?? 10_000)
  log.step(`Checking DNS records (up to ${Math.round(waitMs / 1000)}s)`)
  let latest = current
  try {
    latest = await service.verify(current.id)
  } catch (error) {
    if (serializeSubdomainError(error).kind !== 'rate_limited') throw error
  }
  const deadline = Date.now() + waitMs
  while (latest.status === 'pending' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))))
    latest = await service.get(current.id)
  }
  if (latest.status === 'active') log.success(`${latest.subdomain} is active.`)
  else if (latest.status === 'pending') {
    const pending = pendingDnsRecords(latest)
    if (pending.length) reportPending(latest.subdomain, pending, { heading: 'Not validated yet — still waiting for:', propagationNote: true })
    else log.info('DNS records are validated. Certificate issuance is still in progress.')
  }
  return latest
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
