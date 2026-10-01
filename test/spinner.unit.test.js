import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityFor } from '../dist/wizard/spinner.js'
import { SUBDOMAIN_TOOL_NAMES } from '../dist/wizard/subdomains-mcp.js'

test('every subdomain tool has its own spinner activity instead of the generic ones', () => {
  for (const tool of SUBDOMAIN_TOOL_NAMES) {
    const activity = activityFor(tool)
    assert.ok(activity, `${tool} has no activity`)
    assert.match(activity, /subdomain|DNS/)
  }
  assert.equal(activityFor('mcp__fingerprint__create_subdomain'), 'Creating the custom subdomain')
  assert.equal(activityFor('Bash'), undefined)
})
