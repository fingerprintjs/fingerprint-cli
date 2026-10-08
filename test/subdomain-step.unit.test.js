import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configureRunOutcome, isHostname } from '../dist/wizard/subdomain-step.js'

test('only a completed configure run with the variable written counts as configured', () => {
  assert.equal(configureRunOutcome('completed', true), 'configured')
  assert.equal(configureRunOutcome('completed', false), 'needs_action', 'active, but the app still needs a manual change')
  assert.equal(configureRunOutcome('skipped', false), 'needs_action', 'the user declined the change')
  assert.equal(configureRunOutcome('failed', false), 'failed')
})

test('the hostname prompt accepts a hostname shape and asks again for anything else', () => {
  for (const ok of ['metrics.example.com', ' Metrics.Example.com. ', 'a.b', 'x-1.sub.example.co.uk']) {
    assert.equal(isHostname(ok), true, ok)
  }
  for (const bad of ['', '   ', 'foo', 'hello world', 'https://metrics.example.com', 'metrics.example.com/path', '-a.example.com', 'a-.example.com', 'a..example.com', '.example.com', 'me_trics.example.com']) {
    assert.equal(isHostname(bad), false, JSON.stringify(bad))
  }
})
