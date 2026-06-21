import { password, select } from '@inquirer/prompts'
import { text } from '../utils/prompt.js'
import open from 'open'
import { ApiClient } from '../api/client.js'
import { endpoints } from '../api/endpoints.js'
import { AuthState, saveAuthState, clearAuthState, getAuthState, updateAuthState } from '../auth/tokenStore.js'
import { resolveConfig } from '../config/config.js'
import { workspaceStart } from './workspace.js'
import { integrateCommand } from './integrate.js'

export async function signup(opts: { apiUrl?: string; name?: string; email?: string } = {}) {
  const name = opts.name ?? (await text('Name'))
  const email = opts.email ?? (await text('Email'))
  const cfg = resolveConfig(opts.apiUrl)
  const client = new ApiClient(cfg.apiUrl)

  // Match the dashboard's password rules (mgmt-api checkPasswordStrength): to pass it must contain
  // an uppercase letter, a lowercase letter, a number, and be longer than 8 characters. Surface the
  // criteria up front so users aren't guessing, then let the API be the source of truth below.
  console.log('Password must be 9+ characters and include an uppercase letter, a lowercase letter, and a number.')
  let pass = ''
  for (;;) {
    pass = await password({ message: 'Password (9+ chars, upper + lower + number)' })
    if (pass.length < 9) {
      console.log('Password is not strong enough: must be more than 8 characters.')
      continue
    }
    const strength = await client
      .request<{ strengthLevel: number; feedback?: string }>(endpoints.passwordStrength, {
        method: 'POST',
        body: JSON.stringify({ password: pass }),
      })
      .catch(() => null)
    if (!strength || strength.strengthLevel >= 1) break
    console.log(strength.feedback ? `Password is not strong enough: ${strength.feedback}` : 'Password is not strong enough.')
  }

  try {
    const data = await client.request<any>(endpoints.signupIntentCreate, {
      method: 'POST',
      body: JSON.stringify({ name, email, password: pass, utmInfo: {}, signupSource: 'cli' }),
    })

    saveAuthState({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      userId: data.context?.id,
      apiUrl: cfg.apiUrl,
      region: cfg.region,
    })
    console.log('Signup succeeded. Check your email for the confirmation link.')
    await promptAndConfirmEmail(getAuthState()!)
  } catch (e) {
    console.log(`Signup blocked (${(e as Error).message}). Opening dashboard signup...`)
    await open(`${cfg.dashboardUrl}/signup`)
    console.log('Complete signup in browser, then run: fingerprint login')
  }
}

// Wait for the user to paste the confirmation link, then confirm. Re-prompts on a bad/expired link.
async function promptAndConfirmEmail(auth: AuthState) {
  for (;;) {
    const link = await text('Paste the confirmation link from your email (blank to confirm later)')
    if (!link.trim()) {
      console.log('Confirm later with: fingerprint signup-confirm "<link from email>"')
      return
    }
    try {
      await confirmEmail(auth, link.trim())
    } catch (e) {
      console.log(`${(e as Error).message} — paste the link again, or leave blank to stop.`)
      continue
    }
    await runOnboarding()
    return
  }
}

// After email is confirmed, continue into onboarding: create the first workspace, then integrate
// Fingerprint into the repo in the current directory (provisions keys + applies the integration).
async function runOnboarding() {
  console.log('\nNext: set up your first workspace.')
  await workspaceStart()
  console.log('\nNext: integrate Fingerprint into your project.')
  await integrateCommand()
}

// The confirmation email links to /signup/confirm/<signupIntent>?confirmationCode=<code>.
// Accept either the full pasted link, or <signupIntent> <code> as two parts.
async function confirmEmail(auth: AuthState, linkOrIntent: string, code?: string) {
  let signupIntent = linkOrIntent
  let confirmationCode = code
  if (linkOrIntent.includes('/signup/confirm/')) {
    // We only read pathname + query, so the base host is irrelevant — it works the same for any
    // dashboard (prod dashboard.fingerprint.com, staging dashboard.fpjs.sh, etc.). The placeholder
    // base just lets new URL() accept a pasted path-only link ("/signup/confirm/...") without throwing.
    const url = new URL(linkOrIntent, 'http://placeholder.invalid')
    const match = url.pathname.match(/\/signup\/confirm\/([^/]+)/)
    if (match) signupIntent = decodeURIComponent(match[1])
    confirmationCode = url.searchParams.get('confirmationCode') ?? confirmationCode
  }
  if (!confirmationCode) {
    throw new Error('Missing confirmation code. Paste the full link from your email, or pass <signupIntent> <code>.')
  }

  const client = new ApiClient(auth.apiUrl)
  const data = await client.request<any>(endpoints.signupIntentConfirm, {
    method: 'POST',
    body: JSON.stringify({ signupIntent, confirmationCode }),
  })
  saveAuthState({ ...auth, accessToken: data.accessToken, refreshToken: data.refreshToken })
  console.log('Email confirmed.')
}

export async function signupConfirm(linkOrIntent: string, code?: string) {
  const auth = getAuthState()
  if (!auth?.accessToken) throw new Error('Please run fingerprint signup or login first')
  await confirmEmail(auth, linkOrIntent, code)
  await runOnboarding()
}

export async function login(opts: { apiUrl?: string; email?: string } = {}) {
  const cfg = resolveConfig(opts.apiUrl)

  const email = opts.email ?? (await text('Email'))
  const pass = await password({ message: 'Password' })
  const client = new ApiClient(cfg.apiUrl)

  try {
    const sso = await client.request<any>(endpoints.ssoAuth, { method: 'POST', body: JSON.stringify({ email }) })
    if (sso?.sso?.isEnabled) {
      // SSO requires the browser handoff, which isn't available in this version yet.
      throw new Error('SSO login isn\'t available in this version yet. Use an email/password account for now.')
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('SSO login')) throw err
  }

  const data = await client.request<any>(endpoints.login, {
    method: 'POST',
    body: JSON.stringify({ email, password: pass }),
  })
  saveAuthState({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    userId: data.context?.id,
    apiUrl: cfg.apiUrl,
    region: cfg.region,
  })
  console.log('Logged in successfully.')
  await continueAfterLogin(cfg.apiUrl)
}

// After any login path, select the active workspace and continue into integration for the repo in
// the current directory (the same chain CLI signup uses). `integrate` no-ops with a message if this
// dir isn't a supported stack.
async function continueAfterLogin(apiUrl: string) {
  const hasWorkspace = await selectActiveWorkspace(new ApiClient(apiUrl))
  if (hasWorkspace) {
    console.log('\nNext: integrate Fingerprint into the current project.')
    await integrateCommand()
  }
}

// After authenticating, set the active workspace so `keys`/`integrate` are ready to run.
// Returns true if a workspace is now active.
async function selectActiveWorkspace(client: ApiClient): Promise<boolean> {
  const subs = await client.request<any[]>(endpoints.subscriptions, { method: 'GET' }, true)
  if (subs.length === 0) {
    console.log('No workspaces yet. Create one with: fingerprint workspace start')
    return false
  }
  let id = subs[0].id
  if (subs.length > 1) {
    id = await select({
      message: 'Select active workspace',
      choices: subs.map((s) => ({ name: `${s.name ?? 'workspace'} (${s.id})`, value: s.id })),
    })
  }
  updateAuthState({ currentSubscriptionId: id })
  console.log(`Active workspace: ${subs.find((s) => s.id === id)?.name ?? id}`)
  return true
}

export async function logout() {
  const auth = getAuthState()
  if (auth?.accessToken) {
    const client = new ApiClient(auth.apiUrl)
    try {
      await client.request(endpoints.logout, { method: 'POST' }, true)
    } catch {}
  }
  clearAuthState()
  console.log('Logged out.')
}

export async function whoami() {
  const auth = getAuthState()
  if (!auth?.accessToken) throw new Error('Not logged in')
  const client = new ApiClient(auth.apiUrl)
  const user = await client.request<any>(endpoints.currentUserGet, { method: 'GET' }, true)
  console.log(JSON.stringify({ user, currentSubscriptionId: auth.currentSubscriptionId }, null, 2))
}
