import { confirm, input, select } from '@inquirer/prompts'
import { markFailure } from '../analytics/failure.js'
import { addRunProperties, recordWizardStep } from '../analytics/track.js'
import { ManagementApiError } from '../api/management.js'
import { serializeSubdomainError, type SerializedSubdomainError } from '../api/subdomain-errors.js'
import { normalizeHostname, SubdomainsService, type DnsRecord, type Subdomain, type SubdomainStatus } from '../api/subdomains.js'
import { autoYes, isCi } from '../utils/ci.js'
import { CLOUDFLARE_DNS_ONLY_HINT, dnsRecordLines, dnsRecords, pendingDnsRecords } from '../utils/dns-records.js'
import { DOMAIN_CONNECT_TIMEOUT_MS, listenForDomainConnect, openDomainConnectLink } from '../utils/domain-connect.js'
import { analyzeRepo } from './detect.js'
import { log } from './log.js'
import { Spinner } from './spinner.js'
import { provisionActiveSubdomainEndpoint } from './provision.js'
import { clearPendingSubdomainSetup, savePendingSubdomainSetup } from './subdomain-setups.js'
import type { IntegrateOutcome } from './runner.js'

type ApplyStep = (root: string, hostname: string) => Promise<IntegrateOutcome>

// The subdomain step needs a hostname the agent must not guess, so the CLI asks before the run.
export async function askSubdomainHostname(): Promise<string> {
  const hostname = await input({
    message: 'What subdomain would you like to use? (e.g., metrics.yourdomain.com)',
    validate: (value) => (isHostname(value) ? true : 'Enter a hostname like metrics.yourdomain.com.'),
  })
  return normalizeHostname(hostname)
}

// Shape only, so a typo is asked again instead of ending the run on the API's 422. Whether the
// hostname is acceptable (apex, reserved names, limits) stays the API's call.
const HOSTNAME_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOSTNAME = new RegExp(`^${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})+$`, 'i')
export function isHostname(value: string): boolean {
  return HOSTNAME.test(normalizeHostname(value))
}

export async function askResumeSubdomain(hostname: string): Promise<boolean> {
  log.line()
  return confirm({ message: `Resume the custom subdomain setup for ${hostname}?`, default: true })
}

// Where the subdomain step ended in this run, for the run's analytics event. One value per run:
// `waiting` when the user has to come back, `configured` when the app points at the subdomain,
// `needs_action` when the subdomain is active but the app is not configured yet (no env
// convention for the frontend, or the user declined the change), `failed` for errors.
type SubdomainRunOutcome = 'waiting' | 'configured' | 'needs_action' | 'failed' | 'timed_out'

// The analytics outcome of the configure run: only a completed run with the variable written is
// `configured`; a completed run the CLI could not finish, or a declined one, still needs the user.
export function configureRunOutcome(applyOutcome: IntegrateOutcome, endpointWritten: boolean): SubdomainRunOutcome {
  if (applyOutcome === 'failed') return 'failed'
  if (applyOutcome === 'completed' && endpointWritten) return 'configured'
  return 'needs_action'
}

function recordSubdomainRun(properties: {
  outcome: SubdomainRunOutcome
  resumed?: boolean // unknown when the first lookup itself failed
  dns?: 'manual' | 'domain_connect'
  provider?: string
}): void {
  addRunProperties({
    subdomain_outcome: properties.outcome,
    ...(properties.resumed === undefined ? {} : { subdomain_resumed: properties.resumed }),
    ...(properties.dns ? { subdomain_dns: properties.dns } : {}),
    ...(properties.provider ? { subdomain_provider: properties.provider } : {}),
  })
}

export async function runSubdomainStep(
  root: string,
  hostname: string,
  applyStep: ApplyStep,
  options: { yes?: boolean } = {}
): Promise<IntegrateOutcome> {
  savePendingSubdomainSetup(root, hostname)
  const service = new SubdomainsService()
  let current: Subdomain | undefined
  // Picked up from an earlier run, as opposed to created in this one; unknown until the lookup.
  let resumed: boolean | undefined
  let dns: 'manual' | 'domain_connect' | undefined
  let provider: string | undefined
  const end = (outcome: IntegrateOutcome, ended: SubdomainRunOutcome): IntegrateOutcome => {
    recordSubdomainRun({ outcome: ended, resumed, dns, provider })
    return outcome
  }
  try {
    current = await findSubdomain(service, hostname)
    resumed = Boolean(current)
    let recordsShown = false

    if (!current) {
      log.step(`Setting up ${hostname}`)
      current = await service.create(hostname)
    }

    let explained = false
    let offeredDomainConnect = false
    while (true) {
      if (current.status === 'active') {
        if (!analyzeRepo(root).hasFrontendSkill) {
          log.success(`${hostname} is active.`)
          log.info(
            `No supported frontend detected here. Run fingerprint integrate --subdomain ${hostname} from your frontend directory, or set endpoints to https://${hostname} in your app manually.`
          )
          clearPendingSubdomainSetup(root)
          return end('completed', 'needs_action')
        }
        if (!options.yes && !autoYes() && !(await confirm({ message: `Update your app to use ${hostname}?`, default: true }))) {
          log.info(resumeHint(hostname))
          return end('skipped', 'needs_action')
        }
        const outcome = await applyStep(root, hostname)
        const endpointWritten = outcome === 'completed' ? finishSubdomainSetup(root, hostname) : false
        return end(outcome, configureRunOutcome(outcome, endpointWritten))
      }
      if (current.status === 'failed' || current.status === 'timed_out') {
        clearPendingSubdomainSetup(root)
        return end(reportTerminalStatus(hostname, current.status), current.status)
      }
      if (isCi()) {
        dns ??= 'manual'
        recordWizardStep('dns_manual')
        const pending = pendingDnsRecords(current)
        if (pending.length) reportPending(hostname, pending)
        else log.info(`${hostname}: DNS records are validated. Certificate issuance is still in progress.`)
        log.info(resumeHint(hostname))
        return end('waiting', 'waiting')
      }
      const pending = pendingDnsRecords(current)
      // When the DNS provider supports Domain Connect, the browser can add the records; offered once,
      // and only while there are records left to add. Asked before the records are shown, so the
      // manual list only appears when manual is the way.
      if (!offeredDomainConnect && pending.length) {
        offeredDomainConnect = true
        const added = await offerDomainConnect(service, current)
        if (added) {
          dns = 'domain_connect'
          provider = added.provider && providerSlug(added.provider)
          explainWait(hostname)
          current = await waitForDns(service, current)
          if (current.status !== 'pending') continue
          // The provider added the records, so there is nothing for the manual menu to ask for.
          // Validation is just taking longer than the wait; the saved setup resumes it next run.
          log.info(
            `${added.provider ?? 'Your DNS provider'} added the DNS records, but ${hostname} is not active yet. Propagation and certificate issuance can take a few more minutes.`
          )
          log.info(resumeHint(hostname))
          return end('waiting', 'waiting')
        }
      }
      if (!recordsShown) {
        if (pending.length) reportPending(hostname, pending)
        else log.info(`${hostname}: DNS records are validated. Certificate issuance is still in progress.`)
        recordsShown = true
      }
      if (!dns) {
        dns = 'manual'
        recordWizardStep('dns_manual')
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
      if (choice === 'later') {
        recordWizardStep('finish_later')
        return end('waiting', 'waiting')
      }

      recordWizardStep('dns_check')
      explainWait(hostname)
      current = await waitForDns(service, current)
      if (current.status === 'pending') {
        log.warn(
          `${hostname} is not active after ${Math.round(dnsWaitMs() / 60_000)} minutes. Check that the records match exactly and, on Cloudflare, that they are DNS only (proxying off).`
        )
      }
    }
  } catch (error) {
    recordSubdomainRun({ outcome: 'failed', resumed, dns, provider })
    const serialized = serializeSubdomainError(error)
    // A 422 comes with a generic message that points at `violations`; those are the part to show.
    log.error(`Custom subdomain setup failed: ${describeSubdomainError(serialized)}`)
    markFailure(`subdomain_${serialized.kind}`, serialized.message)
    process.exitCode = 1
    return 'failed'
  }
}

// The provider name as the Management API allows it on `subdomain_provider`: "Cloudflare" → "cloudflare".
function providerSlug(name: string): string | undefined {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return /^[a-z]/.test(slug) ? slug : undefined
}

// Ask the API for a Domain Connect link; when the provider has one, let the user choose the
// browser flow. Returns the provider once it redirected back, meaning the records are in and the
// caller can wait for validation. Any other way out returns undefined and the manual path continues.
async function offerDomainConnect(service: SubdomainsService, current: Subdomain): Promise<{ provider?: string } | undefined> {
  // No loopback listener (a sandbox with no local ports) means no shortcut, not a failed setup.
  const loopback = await listenForDomainConnect().catch((error: unknown) => {
    log.warn(`Domain Connect is not available right now (${error instanceof Error ? error.message : String(error)}). You can add the records yourself.`)
    return undefined
  })
  if (!loopback) return undefined
  try {
    const link = await service.domainConnect(current.id, loopback.port).catch((error) => {
      if (error instanceof ManagementApiError && error.status === 409) return undefined // no Domain Connect here
      if (error instanceof ManagementApiError && error.status === 401) {
        markFailure('subdomain_not_authenticated', error)
        throw error
      }
      // Anything else is the shortcut being unavailable, not the setup failing: the records are known.
      log.warn(`Domain Connect is not available right now (${serializeSubdomainError(error).message}). You can add the records yourself.`)
      return undefined
    })
    if (!link) return undefined
    // Display label only; analytics gets the API's value, or nothing.
    const provider = link.dns_provider ?? 'your DNS provider'

    log.line()
    const choice = await select({
      message: link.dns_provider
        ? `Your domain uses ${provider}. How would you like to add the DNS records?`
        : 'How would you like to add the DNS records?',
      choices: [
        { name: `Add them automatically with ${provider} (opens browser)`, value: 'browser' },
        { name: 'Show me the records to add manually', value: 'manual' },
      ],
    })
    if (choice === 'manual') return undefined
    recordWizardStep('dns_domain_connect')

    for (const line of await openDomainConnectLink(link.domain_connect_url, provider, true)) log.info(line)
    loopback.startTimeout(DOMAIN_CONNECT_TIMEOUT_MS)
    const spinner = process.stdout.isTTY && !isCi() ? new Spinner() : null
    spinner?.start(`Waiting for ${provider}`)
    const result = await loopback.callback
    spinner?.stop()
    if (result.outcome === 'done') {
      log.success(`${provider} added the DNS records.`)
      return { provider: link.dns_provider }
    }
    // The caller lists the records next, as for any other way into the manual path.
    if (result.outcome === 'error') log.warn(`${provider} did not add the records: ${result.error}. You can add them yourself:`)
    else log.warn(`No response from ${provider} after ${DOMAIN_CONNECT_TIMEOUT_MS / 60_000} minutes. You can add the records yourself:`)
    return undefined
  } finally {
    loopback.close()
  }
}

// Provision the endpoint after the agent completes. Without an env convention, show manual guidance.
function finishSubdomainSetup(root: string, hostname: string): boolean {
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
  return result.outcome === 'configured'
}

function describeSubdomainError(serialized: SerializedSubdomainError): string {
  if (!serialized.violations?.length) return serialized.message
  return serialized.violations.map((violation) => `${violation.message} (${violation.property})`).join('; ')
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

// Sets the expectation before the wait: it is long, and nothing is needed from the user.
function explainWait(hostname: string): void {
  log.info(
    `Waiting for the records to propagate and for the certificate to issue. This usually takes a few minutes, sometimes longer; the setup continues on its own once ${hostname} is active, so no need to watch.`
  )
}

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
  markFailure('subdomain_failed')
  process.exitCode = 1
  return 'failed'
}

function resumeHint(hostname: string): string {
  return `Run fingerprint integrate --subdomain ${hostname} to continue later.`
}
