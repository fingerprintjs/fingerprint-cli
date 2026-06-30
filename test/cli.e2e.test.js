import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// End-to-end against the BUILT CLI (dist/index.js), treated as a black box. These run with no
// network and no credentials: they exercise the non-interactive (`--ci`) guardrails, whose whole
// job is to let the wizard run headlessly without a human — which is exactly what a test needs.
const CLI = fileURLToPath(new URL('../dist/index.js', import.meta.url))

// Run the CLI with an isolated HOME so it can't pick up a real `fingerprint login` from the dev's
// machine (auth state lives at $HOME/.config/fingerprint/auth.json). `timeout` is the real assertion
// here: if a prompt ever blocks on stdin in --ci mode, spawnSync kills it and `signal` is set.
function runCli(args, { home } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, HOME: home ?? mkdtempSync(join(tmpdir(), 'fp-home-')), CI: '' },
    encoding: 'utf8',
    input: '', // closed, non-TTY stdin — a hung prompt would read EOF or block
    timeout: 15_000,
  })
}

test('--ci with no auth fails fast instead of hanging', () => {
  const res = runCli(['--ci'])

  // Not killed by the timeout → it exited on its own, i.e. it did not hang on a prompt.
  assert.equal(res.signal, null, `CLI was killed (likely hung): ${res.stderr || res.stdout}`)
  // Non-interactive runs surface a clear next step and exit non-zero rather than prompting.
  assert.notEqual(res.status, 0)
  assert.match(res.stderr + res.stdout, /Not authenticated/i)
})

test('--help runs and lists commands', () => {
  const res = runCli(['--help'])

  assert.equal(res.status, 0)
  assert.match(res.stdout, /Usage: fingerprint/)
  assert.match(res.stdout, /integrate/)
})
