import { password, select } from '@inquirer/prompts'
import { text } from '../utils/prompt.js'
import open from 'open'
import { ApiClient, ApiError } from '../api/client.js'
import { endpoints } from '../api/endpoints.js'
import { AuthState, saveAuthState, clearAuthState, getAuthState, updateAuthState } from '../auth/tokenStore.js'
import { resolveConfig } from '../config/config.js'
import { workspaceStart } from './workspace.js'
import { integrateCommand } from './integrate.js'
import { isVerbose } from '../utils/verbose.js'

export async function signup(opts: { name?: string; email?: string; chain?: boolean } = {}) {
  const name = opts.name ?? (await text('Name'))
  let email = opts.email ?? (await text('Email'))
  const cfg = resolveConfig()
  const client = new ApiClient(cfg.apiUrl)

  // Match the dashboard's password rules (mgmt-api checkPasswordStrength): to pass it must contain
  // an uppercase letter, a lowercase letter, a number, and be longer than 8 characters. Surface the
  // criteria up front so users aren't guessing, then let the API be the source of truth below.
  console.log('Password must be 9+ characters and include an uppercase letter, a lowercase letter, and a number.')
  let pass = await promptForStrongPassword(client)

  // Only the signup request itself falls back to the browser. Confirmation + onboarding run after
  // and must surface their own errors — don't wrap them here or an integrate failure looks like a
  // blocked signup.
  let data: any
  for (;;) {
    try {
      data = await client.request<any>(endpoints.signupIntentCreate, {
        method: 'POST',
        body: JSON.stringify({ name, email, password: pass, utmInfo: {}, signupSource: 'cli' }),
      })
      break
    } catch (e) {
      if (isVerbose()) {
        console.error('CLI signup request failed:', e)
        console.error('CLI signup request failure cause:', (e as Error & { cause?: unknown }).cause)
      }

      if (e instanceof ApiError && e.param === 'email') {
        console.log(`Signup failed: ${e.message}`)
        email = await text('Email')
        continue
      }

      if (e instanceof ApiError && e.param === 'password') {
        console.log(`Signup failed: ${e.message}`)
        pass = await promptForStrongPassword(client)
        continue
      }

      if (isExpectedSignupValidationError(e)) {
        console.log(`Signup failed: ${(e as Error).message}`)
        return
      }

      console.log(`Signup blocked (${(e as Error).message}). Opening dashboard signup...`)
      await open(`${cfg.dashboardUrl}/signup`)
      console.log('Complete signup in browser, then run: fingerprint login')
      return
    }
  }

  saveAuthState({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    userId: data.context?.id,
    apiUrl: cfg.apiUrl,
    region: cfg.region,
    pendingEmailConfirmation: true,
  })
  console.log(`We sent a 6-digit verification code to ${email}.`)
  await promptAndConfirmEmail(getAuthState()!, opts.chain)
}

async function promptForStrongPassword(client: ApiClient): Promise<string> {
  for (;;) {
    const pass = await password({ message: 'Password (9+ chars, upper + lower + number)' })
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
    if (!strength || strength.strengthLevel >= 1) return pass
    console.log(strength.feedback ? `Password is not strong enough: ${strength.feedback}` : 'Password is not strong enough.')
  }
}

function isExpectedSignupValidationError(error: unknown): boolean {
  return error instanceof ApiError && error.status !== undefined && error.status >= 400 && error.status < 500
}

// Confirm the email so onboarding can continue. The CLI email is code-only, so the primary path is
// the authenticated /signup/confirm-code endpoint. Full-link confirmation remains available through
// `fingerprint signup-confirm <link>` for legacy emails or manual recovery, but is not part of the
// normal CLI prompt.
async function promptAndConfirmEmail(auth: AuthState, chain?: boolean) {
  for (;;) {
    const how = await select({
      message: 'Confirm your email to continue',
      choices: [
        { name: 'Enter the 6-digit code from your email', value: 'code' },
        { name: 'Send me a new code', value: 'resend' },
        { name: 'Confirm later', value: 'later' },
      ],
    })

    if (how === 'later') {
      console.log('Confirm later with: fingerprint signup-confirm <code>')
      return
    }

    if (how === 'resend') {
      try {
        await resendConfirmationCode(auth)
        console.log('Sent a new code. Check your email, then enter it here.')
      } catch (e) {
        console.log(`Couldn't send a new code: ${(e as Error).message}`)
      }
      continue
    }

    if (how === 'code') {
      const code = (await text('Enter the 6-digit code from your email')).trim()
      if (!isSixDigitCode(code)) {
        console.log("That doesn't look like a 6-digit code. Try again, or choose another option.")
        continue
      }
      try {
        await confirmWithCode(auth, code)
      } catch (e) {
        const message = (e as Error).message
        console.log(`${message} — try again, or choose "Confirm later" to stop.`)
        if (/expired|request a new confirmation code/i.test(message)) {
          console.log('Tip: choose "Send me a new code" to get a fresh one.')
        }
        continue
      }
      if (chain !== false) await runOnboarding()
      return
    }
  }
}

function isSixDigitCode(value: string): boolean {
  return /^\d{6}$/.test(value)
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
async function confirmEmail(auth: AuthState | null, linkOrIntent: string, code?: string) {
  const cfg = resolveConfig()
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

  const client = new ApiClient(auth?.apiUrl ?? cfg.apiUrl)
  const data = await client.request<any>(endpoints.signupIntentConfirm, {
    method: 'POST',
    body: JSON.stringify({ signupIntent, confirmationCode }),
  })
  const nextAuth: AuthState = auth
    ? {
        ...auth,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        userId: data.context?.id ?? auth.userId,
        pendingEmailConfirmation: false,
      }
    : {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        userId: data.context?.id,
        pendingEmailConfirmation: false,
        apiUrl: cfg.apiUrl,
        region: cfg.region,
      }

  saveAuthState(nextAuth)
  console.log('Email confirmed.')
}

// Ask the backend to email a fresh confirmation code. Authenticated, so it targets the signed-in
// account; the backend reuses the CLI (code-only) template because the signup originated from the CLI.
async function resendConfirmationCode(auth: AuthState) {
  const client = new ApiClient(auth.apiUrl)
  await client.request(endpoints.signupConfirmResend, { method: 'POST' }, true)
}

// Code-first confirmation. The CLI is already authenticated after signup, so we send only the code
// and the backend derives the email from the session (no signupIntent leaves the client).
async function confirmWithCode(auth: AuthState, confirmationCode: string) {
  const client = new ApiClient(auth.apiUrl)
  const data = await client.request<any>(
    endpoints.signupConfirmCode,
    { method: 'POST', body: JSON.stringify({ confirmationCode }) },
    true
  )
  saveAuthState({ ...auth, accessToken: data.accessToken, refreshToken: data.refreshToken, pendingEmailConfirmation: false })
  console.log('Email confirmed.')
}

// Resume an interrupted signup: the account exists locally but its email is still unconfirmed.
// Re-prompt for the confirmation code, then continue onboarding. Used by the default command when
// the user quits after signup and restarts before confirming.
export async function resumeEmailConfirmation() {
  const auth = getAuthState()
  if (!auth?.accessToken) throw new Error('Please run fingerprint signup first')
  await promptAndConfirmEmail(auth)
}

// `fingerprint signup-confirm <codeOrLink> [code]`:
//   - a bare 6-digit code uses the authenticated code-first path (the common case after CLI signup)
//   - anything else (a pasted link, or "<signupIntent> <code>") uses the link fallback
export async function signupConfirm(linkOrIntent: string, code?: string) {
  const auth = getAuthState()
  const input = linkOrIntent.trim()

  if (!code && isSixDigitCode(input)) {
    if (!auth?.accessToken) {
      throw new Error('Run `fingerprint signup` first, or paste the full confirmation link from your email.')
    }
    await confirmWithCode(auth, input)
    await runOnboarding()
    return
  }

  await confirmEmail(auth, input, code)
  await runOnboarding()
}

// `chain: false` authenticates only — skips the workspace+integrate onboarding chain. The launcher
// uses it so logging in to (say) generate a key doesn't drag the user into a full integration.
export async function login(opts: { email?: string; chain?: boolean } = {}) {
  const cfg = resolveConfig()
  await authenticate(opts)
  if (opts.chain !== false) await continueAfterLogin(cfg.apiUrl)
}

async function authenticate(opts: { email?: string } = {}) {
  const cfg = resolveConfig()
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

// Launcher helper: make sure we're authenticated before running a menu action, without the
// onboarding chain. Offers login or signup if needed.
export async function ensureAuth(): Promise<void> {
  if (getAuthState()?.accessToken) return
  const how = await select({
    message: 'You need to sign in first.',
    choices: [
      { name: 'Log in', value: 'login' },
      { name: 'Sign up', value: 'signup' },
    ],
  })
  if (how === 'signup') await signup({ chain: false })
  else await login({ chain: false })
  if (!getAuthState()?.accessToken) throw new Error('Authentication required.')
}

// Launcher helper: make sure an active workspace is selected (picking or creating one if not).
export async function ensureWorkspace(): Promise<void> {
  const auth = getAuthState()
  if (!auth?.accessToken) throw new Error('Not logged in')
  if (auth.currentSubscriptionId) return
  const has = await selectActiveWorkspace(new ApiClient(auth.apiUrl))
  if (!has) await workspaceStart()
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
