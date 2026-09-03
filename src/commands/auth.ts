import { select } from '../utils/prompt.js'
import { clearAuthState, getAuthState } from '../auth/tokenStore.js'
import { loginWithBrowser } from '../auth/browserLogin.js'
import { isCi } from '../utils/ci.js'
import { color } from '../utils/color.js'
import { log } from '../wizard/log.js'
import { integrateCommand } from './integrate.js'
import { pinAuthForTracking, track } from '../analytics/track.js'

type Intent = 'login' | 'signup'

// Decide whether to send the user to sign-in or sign-up before opening the browser. The `login` and
// `signup` commands pass `intent` explicitly; when it's omitted (the bare `fingerprint` entry) we ask
// up front, so a brand-new user lands on sign-up instead of a sign-in page they can't use. In CI
// there's no one to ask — default to sign-in.
async function resolveIntent(intent?: Intent): Promise<{ intent: Intent; chosen: boolean }> {
  if (intent) return { intent, chosen: false }
  if (isCi()) return { intent: 'login', chosen: false }
  const selected = await select<Intent>({
    message: 'Do you already have a Fingerprint account?',
    choices: [
      { name: 'Yes — log in', value: 'login' },
      { name: 'No — create one', value: 'signup' },
    ],
  })
  return { intent: selected, chosen: true }
}

// Authentication is browser-only (PostHog-style): the CLI never collects an email or password, and
// never holds a dashboard session. It opens the dashboard, where the user logs in (or signs up and
// onboards, picking a workspace + region). The dashboard hands a workspace-scoped Management API key
// back to the CLI (see auth/browserLogin.ts), which saves it as the auth state.
//
// `chain: false` authenticates only — skips the integrate step. The launcher uses it so logging in
// to (say) generate a key doesn't drag the user into a full integration. `intent` forces the sign-in
// or sign-up page; omit it to ask the user (same flow either way).
async function authenticate(opts: { chain?: boolean; intent?: Intent } = {}) {
  const { intent, chosen } = await resolveIntent(opts.intent)
  // At the moment of the answer rather than after login returns. Waiting recorded the intent of
  // people who finished and nobody else, which hid the drop-off this event exists to measure: the
  // browser tab closed on the signup form, the login that errored.
  if (chosen) await track('cli_auth_intent_selected', { intent })
  const result = await loginWithBrowser({ intent })
  log.success(`Signed in ${color.dim(`workspace ${color.bold(result.workspaceId)}`)}`)
  // The workspace was chosen in the browser and is already in the auth state, so there's nothing to
  // select here — go straight into integrating the repo in the current directory. `integrate` no-ops
  // with a message if this dir isn't a supported stack.
  if (opts.chain !== false) {
    // Open the phase badge here, not before Sign in: signing in isn't integrating, and a failure
    // during login would otherwise print under an `integrate` heading it has nothing to do with.
    log.heading('integrate')
    await integrateCommand({ skipHeading: true, chained: true })
  }
}

// `fingerprint login` / `fingerprint signup` force the page; the bare `fingerprint` entry uses
// `startAuth`, which asks the user whether they have an account.
export const login = (opts: { chain?: boolean } = {}) => authenticate({ ...opts, intent: 'login' })
export const signup = (opts: { chain?: boolean } = {}) => authenticate({ ...opts, intent: 'signup' })
export const startAuth = (opts: { chain?: boolean } = {}) => authenticate(opts)

// Launcher helper: make sure we're authenticated before running a menu action, without chaining into
// integrate.
export async function ensureAuth(): Promise<void> {
  if (getAuthState()?.managementApiKey) return
  await startAuth({ chain: false })
  if (!getAuthState()?.managementApiKey) throw new Error('Authentication required.')
}

// The CLI stores only a workspace-scoped Management API key, not a session, so logout just drops the
// local credential. The key itself keeps existing in the workspace — revoke it from the dashboard's
// API keys page if needed.
export function logout() {
  // The key is the credential the event is sent with, so pin it before dropping it. The postAction
  // hook reports `logout` after this returns, by which point the auth state is gone.
  pinAuthForTracking(getAuthState())
  clearAuthState()
  log.info('Logged out. (The CLI API key remains in your workspace — revoke it from the dashboard if needed.)')
}

export function whoami() {
  const auth = getAuthState()
  if (!auth?.managementApiKey) throw new Error('Not logged in')
  console.log(`${color.dim('subscription')}  ${color.bold(auth.workspaceId)}`)
  console.log(`${color.dim('region')}        ${color.bold(auth.region)}`)
  // Written only by logins that got an email claim, so older state and issuers without it stay quiet.
  if (auth.email) console.log(`${color.dim('email')}         ${color.bold(auth.email)}`)
}
