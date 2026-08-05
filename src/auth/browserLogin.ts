import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import open from 'open'
import { OAUTH_SCOPES, resolveConfig } from '../config/config.js'
import { color } from '../utils/color.js'
import { log } from '../wizard/log.js'
import { saveAuthState } from './tokenStore.js'

// Browser login is OAuth 2.0 Authorization Code + PKCE against WorkOS AuthKit — the same engine the
// MCP integration uses. The CLI is a public OAuth client: it starts a loopback server, opens the
// browser to WorkOS's authorize endpoint, and exchanges the returned code (with its PKCE verifier)
// for a token. The auth server signs the user in, mints the workspace-scoped Management API key, and
// hands it back inside the token. Because the secret `code_verifier` never leaves the CLI, nothing
// sensitive travels in a browser URL or email.
//
// The token WorkOS returns is a JWT whose `sub` carries the Management API key and whose metadata
// carries the workspace id + region (see mgmt-api `workOsOauthComplete`). The CLI reads them out; the
// same token is also accepted as a Bearer by the LLM gateway (verified there against WorkOS's JWKS).

const CALLBACK_PATH = '/callback'
// Fixed loopback ports (tried in order) so the redirect URIs can be pre-registered in WorkOS. RFC 8252
// native-app loopback: host is always 127.0.0.1, only the port varies.
const CALLBACK_PORTS = [8976, 8977, 8978, 8979, 8980]
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
// Signing up adds email confirmation + onboarding, which takes several minutes — the loopback stays
// open the whole time so the CLI finishes automatically once the user comes back.
const SIGNUP_TIMEOUT_MS = 20 * 60 * 1000

export interface BrowserLoginResult {
  serverApiKey: string
  managementApiKey: string
  workspaceId: string
  region: string
}

interface OAuthServerMetadata {
  authorization_endpoint: string
  token_endpoint: string
}

interface TokenResponse {
  access_token: string
  token_type?: string
  expires_in?: number
  scope?: string
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url')
}

// PKCE: a high-entropy verifier stays in the CLI; only its SHA-256 hash (the challenge) is sent.
function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

// Decode a JWT payload without verifying — we received it directly from WorkOS over TLS, and the LLM
// gateway verifies the signature on its side. We only need to read the claims WorkOS stuffed in.
function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1]
  if (!part) throw new Error('Malformed token from WorkOS.')
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
}

async function discoverEndpoints(issuer: string): Promise<OAuthServerMetadata> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Couldn’t reach the login service (HTTP ${res.status}). Please try again in a few minutes.`)
  }
  const meta = (await res.json()) as Partial<OAuthServerMetadata>
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error('Login service returned unexpected metadata. Please try again in a few minutes.')
  }
  return { authorization_endpoint: meta.authorization_endpoint, token_endpoint: meta.token_endpoint }
}

// Start the loopback server on the first free fixed port and resolve with the captured code once the
// browser is redirected back. Rejects on OAuth error, state mismatch, or timeout.
function startLoopback(
  expectedState: string,
  timeoutMs: number
): Promise<{ port: number; waitForCode: Promise<string>; close: () => void }> {
  return new Promise((resolveServer, rejectServer) => {
    let settleCode: (code: string) => void
    let failCode: (err: Error) => void
    const waitForCode = new Promise<string>((res, rej) => {
      settleCode = res
      failCode = rej
    })

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const ok = !error && code && state === expectedState
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(
        `<!doctype html><meta charset="utf-8"><title>Fingerprint CLI</title>
         <body style="font:16px system-ui;text-align:center;padding:64px">
         <h2>${ok ? 'You’re signed in ✓' : 'Sign-in failed'}</h2>
         <p>${ok ? 'You can close this tab and return to your terminal.' : 'Return to your terminal and try again.'}</p>
         </body>`
      )
      if (error) return failCode(new Error(`Authorization was denied (${error}).`))
      if (!code) return failCode(new Error('No authorization code returned.'))
      if (state !== expectedState) return failCode(new Error('State mismatch — aborting for safety.'))
      settleCode(code)
    })

    const timer = setTimeout(() => failCode(new Error('timeout')), timeoutMs)
    timer.unref?.()
    const close = () => {
      clearTimeout(timer)
      server.close()
    }

    let portIndex = 0
    const tryListen = () => {
      const port = CALLBACK_PORTS[portIndex]
      if (port === undefined) {
        rejectServer(new Error(`Couldn’t open a local port for login (tried ${CALLBACK_PORTS.join(', ')}).`))
        return
      }
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          portIndex += 1
          tryListen()
        } else {
          rejectServer(err)
        }
      })
      server.listen(port, '127.0.0.1', () => {
        const actual = (server.address() as AddressInfo).port
        resolveServer({ port: actual, waitForCode, close })
      })
    }
    tryListen()
  })
}

export async function loginWithBrowser(opts: { intent?: 'login' | 'signup' } = {}): Promise<BrowserLoginResult> {
  const cfg = resolveConfig()
  if (!cfg.oauthIssuer || !cfg.oauthClientId) {
    throw new Error(
      'CLI login is not configured yet (missing OAuth issuer/client id). Set FINGERPRINT_OAUTH_ISSUER and FINGERPRINT_OAUTH_CLIENT_ID.'
    )
  }

  const intent = opts.intent ?? 'login'
  const timeoutMs = intent === 'signup' ? SIGNUP_TIMEOUT_MS : LOGIN_TIMEOUT_MS
  const { verifier, challenge } = createPkce()
  const state = base64url(randomBytes(16))

  const { authorization_endpoint, token_endpoint } = await discoverEndpoints(cfg.oauthIssuer)
  const { port, waitForCode, close } = await startLoopback(state, timeoutMs)
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`

  const authUrl = new URL(authorization_endpoint)
  authUrl.searchParams.set('client_id', cfg.oauthClientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('scope', OAUTH_SCOPES.join(' '))
  authUrl.searchParams.set('state', state)
  // Send brand-new users straight to sign-up (WorkOS AuthKit honors screen_hint); the confirmation
  // email resumes this same authorize flow, and the loopback below waits the whole time.
  if (intent === 'signup') authUrl.searchParams.set('screen_hint', 'sign-up')

  log.step(intent === 'signup' ? 'Sign up' : 'Sign in')
  log.info('Opening your browser...')
  log.info(`  ${color.dim(`If it doesn't open, visit:`)}`)
  log.info(`  ${color.dim(authUrl.toString())}`)
  await open(authUrl.toString()).catch(() => {
    // Browser couldn't be opened automatically; the printed URL is the fallback.
  })
  if (intent === 'signup') {
    log.info('Check your inbox and click the confirmation link, then finish setup in the browser.')
  }
  log.info('\nWaiting for you to finish in the browser. Please return here when you’re done...')

  try {
    const code = await waitForCode.catch((e: Error) => {
      if (e.message === 'timeout') {
        throw new Error(`Timed out after ${Math.round(timeoutMs / 60000)} minutes. Run \`fingerprint ${intent}\` again.`)
      }
      throw e
    })

    const tokenRes = await fetch(token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: cfg.oauthClientId,
        code_verifier: verifier,
      }),
    })
    if (!tokenRes.ok) {
      throw new Error(`Login failed while exchanging the code (HTTP ${tokenRes.status}). Run \`fingerprint ${intent}\` again.`)
    }
    const token = (await tokenRes.json()) as TokenResponse

    // The token subject encodes three dash-separated parts — `serverApiKey-managementApiKey-region` —
    // exactly the format the MCP server reads (region may itself contain dashes, so keep the remainder).
    // The workspace id rides in the `urn:fingerprint:sub_id` claim.
    const claims = decodeJwtPayload(token.access_token)
    const subject = typeof claims.sub === 'string' ? claims.sub : ''
    const firstDash = subject.indexOf('-')
    const secondDash = subject.indexOf('-', firstDash + 1)
    if (firstDash < 0 || secondDash < 0) {
      throw new Error('Login token was not in the expected format. Run `fingerprint login` again.')
    }
    const serverApiKey = subject.slice(0, firstDash)
    const managementApiKey = subject.slice(firstDash + 1, secondDash)
    const region = subject.slice(secondDash + 1)
    const workspaceId = String(claims['urn:fingerprint:sub_id'] ?? '')
    if (!managementApiKey) {
      throw new Error('Login succeeded but no API key was returned. Run `fingerprint login` again.')
    }

    saveAuthState({
      accessToken: token.access_token,
      serverApiKey,
      managementApiKey,
      workspaceId,
      region,
      managementApiUrl: cfg.managementApiUrl,
    })
    return { serverApiKey, managementApiKey, workspaceId, region }
  } finally {
    close()
  }
}
