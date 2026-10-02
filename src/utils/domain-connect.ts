import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import open from 'open'
import { isCi } from './ci.js'

// Domain Connect hands the user to their DNS provider in the browser; the provider adds the
// records and redirects back to a loopback URL the Management API signs into the link. This is
// that loopback: one request, then the caller checks the subdomain with the API.
export const DOMAIN_CONNECT_CALLBACK_PATH = '/domain-connect/callback'
export const DOMAIN_CONNECT_TIMEOUT_MS = 10 * 60 * 1000

// The provider's text is printed to the terminal, and the loopback takes any local caller: strip
// control characters so an escape sequence cannot rewrite the screen, and keep it short.
function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 200)
}

export type DomainConnectCallback = { outcome: 'done' } | { outcome: 'error'; error: string } | { outcome: 'timeout' }

// The port is needed before the link can be requested, but the clock only starts once the user
// is actually sent to the provider: call `startTimeout` right after opening the link.
export function listenForDomainConnect(): Promise<{
  port: number
  callback: Promise<DomainConnectCallback>
  startTimeout: (ms: number) => void
  close: () => void
}> {
  return new Promise((resolve, reject) => {
    let settle: (result: DomainConnectCallback) => void = () => {}
    const callback = new Promise<DomainConnectCallback>((res) => {
      settle = res
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== DOMAIN_CONNECT_CALLBACK_PATH) {
        res.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(
        `<!doctype html><meta charset="utf-8"><title>Fingerprint CLI</title>
         <body style="font:16px system-ui;text-align:center;padding:64px">
         <h2>${error ? 'DNS setup did not complete' : 'DNS records added ✓'}</h2>
         <p>${error ? 'Return to your terminal for details.' : 'You can close this tab and return to your terminal.'}</p>
         </body>`
      )
      settle(error ? { outcome: 'error', error: printable(url.searchParams.get('error_description') ?? error) } : { outcome: 'done' })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        callback,
        startTimeout: (ms) => {
          timer = setTimeout(() => settle({ outcome: 'timeout' }), ms)
          timer.unref?.()
        },
        close: () => {
          if (timer) clearTimeout(timer)
          server.close()
        },
      })
    })
  })
}

// Open the link in the browser, or just print it: in CI, when asked not to, or when
// FINGERPRINT_NO_BROWSER is set (tests, SSH sessions). Returns the lines to show the user.
export async function openDomainConnectLink(url: string, provider: string, openBrowser: boolean): Promise<string[]> {
  const print = !openBrowser || isCi() || Boolean(process.env.FINGERPRINT_NO_BROWSER)
  if (print) return [`Open this link to add the records at ${provider} (Domain Connect):`, `  ${url}`, 'Authorize the change there, then come back here.']
  await open(url).catch(() => {})
  return [`Opening ${provider} (Domain Connect) in your browser... If it doesn't open, visit:`, `  ${url}`, 'Authorize the change there, then come back here.']
}
