import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { summarizeTraffic, suggest, verifiesServerSide } from '../dist/wizard/traffic.js'

const ev = (url, extra = {}) => ({ event_id: 'e', timestamp: 1, url, identification: { visitor_id: 'v', confidence: { score: 0.9 } }, ...extra })
const many = (n, url, extra) => Array.from({ length: n }, () => ev(url, extra))
// A pull where the sample is the whole window, so whole-window counts and sampled counts agree.
const complete = (sample) => ({
  sample,
  sampleComplete: true,
  badBots: sample.filter((e) => e.bot === 'bad'),
  highSuspect: sample.filter((e) => e.suspect_score >= 50),
})

test('summarizeTraffic groups by path, counts whole-window signals apart from the sample', () => {
  const s = summarizeTraffic({
    sample: [
      ev('https://app.example.com/login', { bot: 'bad' }),
      ev('https://app.example.com/login?next=/', { vpn: true, replayed: true }),
      ev('https://app.example.com/signup', { suspect_score: 60, identification: { visitor_id: 'w', confidence: { score: 0.2 } } }),
      ev(undefined),
    ],
    // Filtered pulls see the whole window: more bad bots than the sample holds, on a page the
    // sample never saw.
    badBots: [...many(3, 'https://app.example.com/login', { bot: 'bad' }), ev('https://app.example.com/reset', { bot: 'bad' })],
    highSuspect: [ev('https://app.example.com/signup', { suspect_score: 60 })],
    sampleComplete: false,
  })
  assert.equal(s.sampled, 4)
  assert.equal(s.badBots, 4)
  assert.equal(s.sampleComplete, false)
  assert.deepEqual(
    s.pages.map((p) => [p.path, p.badBots, p.highSuspect, p.sampled, p.sampledBadBots, p.vpn, p.replayed, p.lowConfidence, p.visitors]),
    [
      ['/login', 3, 0, 2, 1, 1, 1, 0, 1],
      ['/signup', 0, 1, 1, 0, 0, 0, 1, 1],
      ['/reset', 1, 0, 0, 0, 0, 0, 0, 0],
      ['(no url)', 0, 0, 1, 0, 0, 0, 0, 1],
    ]
  )
})

test('suggest: bad bots and missing server-side verification, nothing on clean traffic', () => {
  const clean = summarizeTraffic(complete(many(100, 'https://x/login')))
  assert.deepEqual(suggest(clean, { verifiesServerSide: true }), [])

  const bots = summarizeTraffic(complete([...many(90, 'https://x/login'), ...many(10, 'https://x/login', { bot: 'bad' })]))
  const got = suggest(bots, { verifiesServerSide: false }, { days: 7 })
  assert.deepEqual(
    got.map((s) => s.title),
    ['Verify identification server-side', 'Block bad bots on /login']
  )
  assert.match(got[1].detail, /10 bad-bot events in the last 7 days \(10% of its 100 events\)/)

  // Four bad bots in the whole window is not a finding.
  const few = summarizeTraffic(complete(many(4, 'https://x/a', { bot: 'bad' })))
  assert.deepEqual(suggest(few, { verifiesServerSide: true }), [])
})

test('suggest quotes the sampled share only when the sample has enough of the page', () => {
  const busy = summarizeTraffic({
    sample: [...many(40, 'https://x/login'), ...many(10, 'https://x/login', { bot: 'bad' }), ...many(3, 'https://x/jobs', { bot: 'bad' })],
    badBots: [...many(500, 'https://x/login', { bot: 'bad' }), ...many(20, 'https://x/jobs', { bot: 'bad' })],
    highSuspect: [],
    sampleComplete: false,
  })
  const [login, jobs] = suggest(busy, { verifiesServerSide: true })
  assert.match(login.detail, /500 bad-bot events in the report window \(~20% of its traffic, sampled\)/)
  assert.match(jobs.detail, /^20 bad-bot events in the report window\. /)
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
