import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { AddressInfo } from 'node:net'
import open from 'open'
import { resolveConfig } from '../config/config.js'
import { saveAuthState } from './tokenStore.js'

// Browser login mirrors the MCP auth flow: we open the dashboard's login page with a redirect to a
// dashboard page (/cli-auth) that, once the user is authenticated, sends the freshly-minted session
// tokens back to a one-shot loopback server we run here. No client secret, no token exchange in the
// CLI — the dashboard/mgmt-api do that and hand us a normal { accessToken, refreshToken } session.
//
// Contract with the dashboard /cli-auth page:
//   open:     <dashboardUrl>/login?redirect_to=<urlenc('/cli-auth?port=<port>&state=<state>')>
//   redirect: http://127.0.0.1:<port>/callback?state=<state>&access_token=<..>&refresh_token=<..>[&user_id=<..>]
//   on error: http://127.0.0.1:<port>/callback?state=<state>&error=<message>
// We validate `state` to defend the loopback against unrelated requests.

const CALLBACK_PATH = '/callback'
const TIMEOUT_MS = 5 * 60 * 1000

export interface BrowserLoginResult {
  accessToken: string
  refreshToken?: string
  userId?: string
  isSignup: boolean
}

export async function loginWithBrowser(opts: { apiUrl?: string } = {}): Promise<BrowserLoginResult> {
  const cfg = resolveConfig(opts.apiUrl)
  const state = randomBytes(16).toString('hex')

  return new Promise<BrowserLoginResult>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end()
        return
      }

      const params = url.searchParams
      const fail = (message: string) => {
        respond(res, false, message)
        cleanup()
        reject(new Error(message))
      }

      if (params.get('state') !== state) return fail('Login failed: state mismatch (possible stale or forged callback).')
      const error = params.get('error')
      if (error) return fail(`Login failed: ${error}`)

      const accessToken = params.get('access_token')
      if (!accessToken) return fail('Login failed: no access token in callback.')

      const result: BrowserLoginResult = {
        accessToken,
        refreshToken: params.get('refresh_token') ?? undefined,
        userId: params.get('user_id') ?? undefined,
        isSignup: params.get('is_signup') === 'true',
      }

      saveAuthState({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        userId: result.userId,
        apiUrl: cfg.apiUrl,
        region: cfg.region,
      })

      respond(res, true)
      cleanup()
      resolve(result)
    })

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Login timed out after 5 minutes. Run `fingerprint login` again.'))
    }, TIMEOUT_MS)
    timer.unref()

    const cleanup = () => {
      clearTimeout(timer)
      server.close()
    }

    server.on('error', (e) => {
      cleanup()
      reject(new Error(`Could not start local login server: ${e.message}`))
    })

    // Bind to an ephemeral port on the loopback interface only.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      const redirectTo = `/cli-auth?port=${port}&state=${state}`
      const loginUrl = `${cfg.dashboardUrl}/login?redirect_to=${encodeURIComponent(redirectTo)}`
      console.log('\nOpening your browser to sign in...')
      console.log(`If it doesn't open, visit:\n  ${loginUrl}\n`)
      open(loginUrl).catch(() => {
        // Browser couldn't be opened automatically; the printed URL is the fallback.
      })
    })
  })
}

// Minimal HTML so the browser tab shows a clear "done, go back to the terminal" message.
function respond(res: import('node:http').ServerResponse, ok: boolean, message?: string) {
  const title = ok ? 'Signed in to Fingerprint' : 'Sign-in failed'
  const body = ok ? 'You can close this tab and return to the terminal.' : (message ?? 'Something went wrong.')
  res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html' })
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
      `<body style="font-family:system-ui;max-width:30rem;margin:6rem auto;text-align:center">` +
      `<h2>${title}</h2><p>${body}</p></body></html>`
  )
}
