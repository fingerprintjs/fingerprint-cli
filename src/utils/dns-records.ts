import type { DnsRecord, Subdomain } from '../api/subdomains.js'

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

// One record as the lines printed for it, without indentation.
export function dnsRecordLines(record: Pick<DnsRecord, 'type' | 'host' | 'value' | 'status'>): string[] {
  return [`${record.type}  ${record.status}`, `  Host   ${record.host}`, `  Value  ${record.value}`]
}
