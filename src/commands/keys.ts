import { select } from '@inquirer/prompts'
import { ApiClient } from '../api/client.js'
import { fetchPublicKey, createSecretKey } from '../api/keys.js'
import { requireAuth } from '../utils/session.js'
import { isCi } from '../utils/ci.js'

// `fingerprint keys [type]` — generate/fetch an API key for the active workspace and print it.
// Use this when you just need a credential to copy; `fingerprint integrate` is what writes keys
// into your .env files and wires them into the code. With no `type` it asks which key you want.
export async function keysCommand(type?: string) {
  const auth = requireAuth()
  if (!auth.currentSubscriptionId) {
    throw new Error('No active workspace. Run: fingerprint login (or: fingerprint workspace use <id>)')
  }
  const client = new ApiClient(auth.apiUrl)

  const kind = type ?? (await pickKind())

  if (kind === 'public') {
    const key = await fetchPublicKey(client, auth.currentSubscriptionId)
    if (!key) throw new Error('No public API key found in this workspace.')
    console.log(key)
  } else if (kind === 'secret') {
    console.log(await createSecretKey(client, auth.currentSubscriptionId))
  } else {
    throw new Error(`Unknown key type "${kind}". Use "public" or "secret".`)
  }
}

async function pickKind(): Promise<string> {
  if (isCi()) throw new Error('Specify the key type in non-interactive mode: fingerprint keys <public|secret>')
  return select({
    message: 'Which API key do you need?',
    choices: [
      { name: 'Public — browser / JS Agent (client-side)', value: 'public' },
      { name: 'Secret — server-to-server verification (creates a new key)', value: 'secret' },
    ],
  })
}
