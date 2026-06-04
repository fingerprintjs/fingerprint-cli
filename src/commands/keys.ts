import { confirm } from '@inquirer/prompts'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ApiClient } from '../api/client.js'
import { endpoints } from '../api/endpoints.js'
import { requireAuth } from '../utils/session.js'

// Generate the API keys for the active workspace and write them to .env in the current
// project directory. The public key is auto-created with the workspace; the secret key is
// created on demand; the MCP key is optional (may be disabled by a workspace feature flag).
export async function credentialsStep() {
  const auth = requireAuth()
  const client = new ApiClient(auth.apiUrl)
  const subscriptionId = await resolveSubscriptionId(client, auth.currentSubscriptionId)

  const tokens = await client.request<any[]>(endpoints.tokens(subscriptionId), { method: 'GET' }, true)
  const publicKey = tokens.find((t) => t.type === 'browser')?.token
  if (publicKey) console.log('Found existing Public API key.')

  let secretKey: string | undefined
  if (await confirm({ message: 'Generate a Secret API key?', default: true })) {
    const created = await client.request<any>(endpoints.tokens(subscriptionId), {
      method: 'POST',
      body: JSON.stringify({ type: 'api', name: 'CLI Secret Key' }),
    }, true)
    secretKey = created.token
    console.log('Created Secret API key.')
  }

  let mcpKey: string | undefined
  try {
    const mcp = await client.request<any>(endpoints.mcpToken(subscriptionId), { method: 'POST' }, true)
    mcpKey = mcp.mcpToken
    console.log('Created MCP API key.')
  } catch (e) {
    console.log(`Skipped MCP API key (${(e as Error).message}).`)
  }

  const written = writeEnv({
    FINGERPRINT_PUBLIC_API_KEY: publicKey,
    FINGERPRINT_SECRET_API_KEY: secretKey,
    FINGERPRINT_MCP_API_KEY: mcpKey,
  })

  if (written.length === 0) {
    console.log('No keys written.')
    return
  }
  console.log(`Wrote ${written.join(', ')} to ${join(process.cwd(), '.env')}`)
  console.log('Make sure .env is in your .gitignore.')
}

async function resolveSubscriptionId(client: ApiClient, current?: string): Promise<string> {
  if (current) return current
  const subs = await client.request<any[]>(endpoints.subscriptions, { method: 'GET' }, true)
  if (subs.length === 1) return subs[0].id
  throw new Error('No active workspace. Run: fingerprint workspace use <id>')
}

// Upsert the given keys into ./.env, preserving any other lines already present.
function writeEnv(vars: Record<string, string | undefined>): string[] {
  const envPath = join(process.cwd(), '.env')
  let lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').replace(/\n+$/, '').split('\n') : []
  if (lines.length === 1 && lines[0] === '') lines = []

  const written: string[] = []
  for (const [key, value] of Object.entries(vars)) {
    if (!value) continue
    const line = `${key}=${value}`
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`))
    if (idx >= 0) lines[idx] = line
    else lines.push(line)
    written.push(key)
  }

  if (written.length > 0) writeFileSync(envPath, lines.join('\n') + '\n')
  return written
}
