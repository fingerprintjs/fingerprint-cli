import type { DnsRecord, Subdomain } from '../api/subdomains.js'
import { color } from './color.js'

// How DNS records are shown, shared by the `subdomains` commands and the wizard so both surfaces
// read the same, including the one DNS mistake that silently prevents validation.
export const CLOUDFLARE_DNS_ONLY_HINT =
  'On Cloudflare, set the records to DNS only (proxying off) — proxied records do not validate.'

export function dnsRecords(subdomain: Subdomain): DnsRecord[] {
  return [
    subdomain.dns_records.verification,
    ...subdomain.dns_records.routing,
    ...(subdomain.dns_records.caa ? [subdomain.dns_records.caa] : []),
  ]
}

export function pendingDnsRecords(subdomain: Subdomain): DnsRecord[] {
  return dnsRecords(subdomain).filter((record) => record.status !== 'validated')
}

// One record as the lines printed for it, without indentation. The values are what the user
// copies into their DNS provider, so they get the color; color is a no-op without a TTY.
export function dnsRecordLines(record: Pick<DnsRecord, 'type' | 'host' | 'value' | 'status'>): string[] {
  return [
    `${color.bold(record.type)}  ${color.dim(record.status)}`,
    `  ${color.dim('Host ')}  ${color.cyan(record.host)}`,
    `  ${color.dim('Value')}  ${color.cyan(record.value)}`,
  ]
}
