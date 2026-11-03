import { confirm } from '@inquirer/prompts'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { log } from './log.js'
import { color } from '../utils/color.js'

// Fingerprint's remote MCP server. Each client signs in to it on first use with its own OAuth flow;
// the CLI's login can't be handed over (short-lived token, rotating refresh token).
const MCP_URL = 'https://mcp.fpjs.io/mcp'
const MCP_DOCS = 'https://docs.fingerprint.com/docs/mcp-server'
const CLAUDE_ADD = ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'fingerprint', MCP_URL]

interface McpClient {
  name: string
  // Where the server was added, shown next to the success line.
  target: string
  // Adds the server; false when it was already there.
  add: () => boolean
}

// Claude Code counts when its CLI runs; Cursor when its config folder exists.
function detectClients(): McpClient[] {
  const clients: McpClient[] = []
  if (runs('claude', ['--version'])) {
    clients.push({
      name: 'Claude Code',
      target: `claude ${CLAUDE_ADD.join(' ')}`,
      add: () => {
        try {
          execFileSync('claude', CLAUDE_ADD, { stdio: 'pipe', timeout: 15_000 })
          return true
        } catch (e) {
          // Only a user-scope registration counts as already there; `mcp get` also matches project or local ones.
          if (/already exists in user config/.test(output(e))) return false
          throw e
        }
      },
    })
  }
  if (existsSync(join(homedir(), '.cursor'))) {
    clients.push({ name: 'Cursor', target: '~/.cursor/mcp.json', add: addToCursor })
  }
  return clients
}

function runs(bin: string, args: string[]): boolean {
  try {
    execFileSync(bin, args, { stdio: 'ignore', timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

// What a failed command printed, falling back to the error message.
function output(e: unknown): string {
  const { stderr, stdout, message } = e as { stderr?: Buffer; stdout?: Buffer; message: string }
  return `${stderr ?? ''}${stdout ?? ''}`.trim() || message
}

function addToCursor(): boolean {
  const path = join(homedir(), '.cursor', 'mcp.json')
  // An empty file counts as no config; an unreadable one throws rather than being overwritten.
  const text = existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
  const current = text ? JSON.parse(text) : {}
  const next = withFingerprintServer(current)
  if (!next) return false
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
  return true
}

// The Cursor config with the Fingerprint server added, or undefined when it's already there.
export function withFingerprintServer(config: Record<string, any>): Record<string, any> | undefined {
  if (config.mcpServers?.fingerprint) return undefined
  return { ...config, mcpServers: { ...config.mcpServers, fingerprint: { url: MCP_URL } } }
}

export async function connectMcp(): Promise<void> {
  log.step('Connect Fingerprint to your coding agent')
  const clients = detectClients()
  if (!clients.length) {
    log.info('No supported agent found. To add it yourself:')
    log.info(`  ${'Claude Code'.padEnd(13)} claude ${CLAUDE_ADD.join(' ')}`)
    log.info(`  ${'Other agents'.padEnd(13)} add ${MCP_URL} as a remote (HTTP) MCP server`)
    log.kv('Docs', color.dim(MCP_DOCS))
    log.end()
    return
  }

  const names = clients.map((c) => c.name).join(' and ')
  log.info(`Found: ${clients.map((c) => c.name).join(', ')}`)
  log.line()
  if (!(await confirm({ message: `Add the Fingerprint MCP server to ${names}? (user-level, only on this machine)` }))) {
    log.end()
    return
  }

  const width = Math.max(...clients.map((c) => `Already in ${c.name}`.length)) + 3
  for (const client of clients) {
    try {
      const label = client.add() ? `Added to ${client.name}` : `Already in ${client.name}`
      log.success(`${label.padEnd(width)}${color.dim(`(${client.target})`)}`)
    } catch (e) {
      log.warn(`Couldn't add to ${client.name}: ${output(e)}`)
    }
  }
  log.line()
  log.info('The first time you use it, your agent opens the browser once to sign in to Fingerprint.')
  log.line()
  log.info('Try asking your agent:')
  log.info('  "Show my last 10 Fingerprint events and their Smart Signals"')
  log.info('  "Why was my latest visitor flagged?"')
  log.info('  "Is my custom subdomain active yet?"')
  log.line()
  log.kv('Docs', color.dim(MCP_DOCS))
  log.end()
}
