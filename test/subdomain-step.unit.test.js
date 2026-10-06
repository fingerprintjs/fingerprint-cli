import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configureRunOutcome } from '../dist/wizard/subdomain-step.js'

test('only a completed configure run with the app configured counts as configured', () => {
  assert.equal(configureRunOutcome('completed', true), 'configured')
  assert.equal(configureRunOutcome('completed', false), 'needs_action', 'active, but the app still needs a manual change')
  assert.equal(configureRunOutcome('skipped', false), 'needs_action', 'the user declined the change')
  assert.equal(configureRunOutcome('failed', false), 'failed')
})
