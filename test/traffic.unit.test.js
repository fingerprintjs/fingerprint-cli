import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { summarizeTraffic, suggest, verifiesServerSide } from '../dist/wizard/traffic.js'

const ev = (url, extra = {}) => ({ event_id: 'e', timestamp: 1, url, identification: { visitor_id: 'v', confidence: { score: 0.9 } }, ...extra })

test('summarizeTraffic groups by path and counts signals', () => {
  const s = summarizeTraffic([
    ev('https://app.example.com/login', { bot: 'bad' }),
    ev('https://app.example.com/login?next=/', { vpn: true, replayed: true }),
    ev('https://app.example.com/signup', { suspect_score: 60, identification: { visitor_id: 'w', confidence: { score: 0.2 } } }),
    ev(undefined),
  ])
  assert.equal(s.events, 4)
  assert.deepEqual(
    s.pages.map((p) => [p.path, p.events, p.badBots, p.vpn, p.replayed, p.highSuspect, p.lowConfidence, p.visitors]),
    [
      ['/login', 2, 1, 1, 1, 0, 0, 1],
      ['/signup', 1, 0, 0, 0, 1, 1, 1],
      ['(no url)', 1, 0, 0, 0, 0, 0, 1],
    ]
  )
})

test('suggest: bad bots and missing server-side verification, nothing on clean traffic', () => {
  const clean = summarizeTraffic(Array.from({ length: 100 }, () => ev('https://x/login')))
  assert.deepEqual(suggest(clean, { verifiesServerSide: true }), [])

  const bots = summarizeTraffic([...Array.from({ length: 90 }, () => ev('https://x/login')), ...Array.from({ length: 10 }, () => ev('https://x/login', { bot: 'bad' }))])
  const titles = suggest(bots, { verifiesServerSide: false }).map((s) => s.title)
  assert.deepEqual(titles, ['Verify identification server-side', 'Block bad bots on /login'])

  // Four bad bots on a tiny page is not a finding: the thresholds need both a count and a share.
  const few = summarizeTraffic([...Array.from({ length: 4 }, () => ev('https://x/a', { bot: 'bad' }))])
  assert.deepEqual(suggest(few, { verifiesServerSide: true }), [])
})

test('verifiesServerSide finds the Server SDK and skips node_modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'fp-verify-'))
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'x', 'index.js'), "require('@fingerprint/server-sdk')")
  writeFileSync(join(root, 'app.js'), 'console.log(1)')
  assert.equal(verifiesServerSide(root), false)
  writeFileSync(join(root, 'api.ts'), "import { FingerprintServerApi } from '@fingerprint/server-sdk'")
  assert.equal(verifiesServerSide(root), true)
})
