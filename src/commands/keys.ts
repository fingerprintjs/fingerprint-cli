import { select } from '@inquirer/prompts'
import { ManagementClient } from '../api/management.js'
import { fetchPublicKey } from '../api/keys.js'
import { requireAuth } from '../utils/session.js'
import { isCi } from '../utils/ci.js'
import { addRunProperties } from '../analytics/track.js'

// `fingerprint keys [type]` — fetch an API key for the logged-in workspace and print it. Use this when
// you just need a credential to copy; `fingerprint integrate` is what writes keys into your .env files
// and wires them into the code. With no `type` it asks which key you want.
export async function keysCommand(type?: string) {
  const auth = requireAuth()
  const client = new ManagementClient()

  const kind = type ?? (await pickKind())
  // Which key was asked for is invisible upstream: `cli_command_run` reports `keys` either way, and
  // `cli_flags` collects only `--options`, never the positional. The Management API allowlists event
  // names, so this rides along as a property of this run's events rather than as one of its own.
  addRunProperties({ key_type: kind, key_type_prompted: type === undefined })

  if (kind === 'public') {
    const key = await fetchPublicKey(client)
    if (!key) throw new Error('No public API key found in this workspace.')
    console.log(key)
  } else if (kind === 'secret') {
    if (!auth.serverApiKey) throw new Error('No Server API key found. Run `fingerprint login` again.')
    console.log(auth.serverApiKey)
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
      { name: 'Secret — server-to-server verification', value: 'secret' },
    ],
  })
}
