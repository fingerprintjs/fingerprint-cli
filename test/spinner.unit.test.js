import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityFor } from '../dist/wizard/spinner.js'

test('agent activities describe code work, not subdomain lifecycle operations', () => {
  assert.equal(activityFor('Read'), 'Exploring your codebase')
  assert.equal(activityFor('Write'), 'Applying changes')
  assert.equal(activityFor('mcp__fingerprint__create_subdomain'), undefined)
  assert.equal(activityFor('Bash'), undefined)
})
