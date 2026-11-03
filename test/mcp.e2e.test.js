import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startManagementApi, startGateway, makeHome, seedAuth, makeRepo, makeSkillsDir, runCli } from './helpers/harness.js'

// The "What's next?" menu offers to add Fingerprint's MCP server to the coding agents on this
// machine: Claude Code through its own CLI, Cursor by merging into ~/.cursor/mcp.json.

// The select wraps: UP from the first entry is "Stop here", once more is the MCP entry above it.
const STOP = '\x1b[A\n'
const MCP = '\x1b[A\x1b[A\n'

let api
before(async () => {
  api = await startManagementApi()
})
after(async () => {
  await api.close()
})

// A `claude` on PATH that logs its arguments; `--version` exits with `versionExit`, `mcp get` with 1
// (the server isn't there yet), everything else with 0.
function fakeClaude(versionExit = 0) {
  const bin = mkdtempSync(join(tmpdir(), 'fp-bin-'))
  const calls = join(bin, 'calls.log')
  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/sh\necho "$@" >> "${calls}"\n[ "$1" = "--version" ] && exit ${versionExit}\n[ "$1 $2" = "mcp get" ] && exit 1\nexit 0\n`
  )
  chmodSync(join(bin, 'claude'), 0o755)
  return { path: `${bin}:${process.env.PATH}`, calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '') }
}

async function runToMcp({ home, path }, afterPick) {
  const repo = makeRepo()
  const gw = await startGateway(join(repo, 'web', 'fingerprint.js'), '// integration\n')
  try {
    return await runCli(['integrate'], {
      home,
      cwd: repo,
      env: { FINGERPRINT_SKILLS_DIR: makeSkillsDir(), FINGERPRINT_GATEWAY_URL: gw.url, PATH: path },
      respond: [
        { when: /Integrate Fingerprint into this repo/, send: 'y\n' },
        { when: /What's next\?/, send: MCP }, // [server-side verification, custom subdomain, MCP, stop]
        ...afterPick,
      ],
    })
  } finally {
    await gw.close()
  }
}

test('connecting MCP adds the server to Claude Code and Cursor, keeping Cursor servers already there', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  mkdirSync(join(home, '.cursor'))
  writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { url: 'https://other.example/mcp' } } }))
  const claude = fakeClaude()

  const res = await runToMcp({ home, path: claude.path }, [
    { when: /Add the Fingerprint MCP server/, send: 'y\n' },
    { when: /Is my custom subdomain active yet\?[\s\S]*What's next\?/, send: STOP },
  ])

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /Found: Claude Code, Cursor/)
  assert.match(res.stdout, /Added to Claude Code/)
  assert.match(res.stdout, /Added to Cursor/)
  assert.match(res.stdout, /opens the browser once to sign in/)
  assert.match(claude.calls(), /^mcp add --scope user --transport http fingerprint https:\/\/mcp\.fpjs\.io\/mcp$/m)
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers, {
    other: { url: 'https://other.example/mcp' },
    fingerprint: { url: 'https://mcp.fpjs.io/mcp' },
  })
  // Back at the menu: no test-this-step hint for MCP, and MCP isn't offered twice.
  const menu = res.stdout.slice(res.stdout.lastIndexOf('Is my custom subdomain active yet?'))
  assert.doesNotMatch(menu, /Test this step now/)
  assert.doesNotMatch(menu, /Connect Fingerprint to your coding agent \(MCP\)/)
})

test('with no supported agent, connecting MCP prints how to add it by hand and writes nothing', async () => {
  const home = makeHome()
  seedAuth(home, api.url)
  const claude = fakeClaude(1)

  const res = await runToMcp({ home, path: claude.path }, [{ when: /No supported agent found[\s\S]*What's next\?/, send: STOP }])

  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /No supported agent found/)
  assert.match(res.stdout, /claude mcp add --scope user --transport http fingerprint https:\/\/mcp\.fpjs\.io\/mcp/)
  assert.doesNotMatch(res.stdout, /Add the Fingerprint MCP server/)
  assert.doesNotMatch(claude.calls(), /mcp add/)
  assert.equal(existsSync(join(home, '.cursor')), false)
})
