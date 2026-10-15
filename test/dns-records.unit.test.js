import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dnsRecords, pendingDnsRecords } from '../dist/utils/dns-records.js'

test('HTTP validation counts only real DNS records', () => {
  const routing = [
    { type: 'A', host: 'metrics.example.com', value: '1.2.3.4', status: 'pending_validation' },
    { type: 'A', host: 'metrics.example.com', value: '5.6.7.8', status: 'validated' },
  ]
  const subdomain = { dns_records: {
    verification: { type: 'CNAME', host: '', value: '', status: 'validated' },
    routing,
  } }
  assert.deepEqual(dnsRecords(subdomain), routing)
  assert.deepEqual(pendingDnsRecords(subdomain), [routing[0]])
})

test('older subdomains keep their verification CNAME and optional CAA', () => {
  const verification = { type: 'CNAME', host: '_acme-challenge.metrics.example.com', value: 'validation.example.com', status: 'pending_validation' }
  const caa = { type: 'CAA', host: 'metrics.example.com', value: '0 issue "pki.goog"', status: 'validated' }
  const subdomain = { dns_records: { verification, routing: [], caa } }
  assert.deepEqual(dnsRecords(subdomain), [verification, caa])
  assert.deepEqual(pendingDnsRecords(subdomain), [verification])
})
