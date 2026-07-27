# CLI Browser Login — How It Works (Plain English)

This explains how `fingerprint login` (and `fingerprint signup`) sign you in through
the browser, what the CLI actually does, and why it can get "stuck" or fail with
`fetch failed`.

> **Note:** an earlier version of this used a poll/`hash` + Redis "locker" design with
> a dashboard `/cli-auth` page and `mgmt-api` endpoints. That was **fully removed**. The
> CLI now uses **standard OAuth 2.0** against the MCP auth server. If you find references
> to `cli-auth-poll`, `cli-auth-accept`, or a `hash`, they're stale — ignore them.

---

## 1. The problem it solves

The CLI needs a **workspace-scoped Management API key** so it can create keys and
environments on your behalf. We don't want you pasting keys by hand. So instead:

> You run `fingerprint login`, your browser opens, you sign in like normal, and the CLI
> quietly receives a key for your workspace.

The tricky part: **the browser and the terminal are two separate programs.** The terminal
can *open* a browser, but it can't *see* what you did in it. OAuth solves exactly this.

---

## 2. The idea (standard OAuth, like every CLI you've used)

This is the same flow as `gh auth login`, `vercel login`, PostHog's CLI, etc.:

1. The **terminal** opens a tiny local web server on `127.0.0.1` (a "loopback") and
   generates a one-time secret (**PKCE verifier**) that never leaves your machine.
2. It opens the browser to the auth server's **authorize** page, handing over only the
   *hash* of that secret (the **PKCE challenge**) plus a return address (`redirect_uri`
   pointing back at the loopback).
3. **You** sign in (or sign up) on the auth server's page and pick/complete a workspace.
4. The auth server redirects your browser back to the loopback with a one-time **code**.
5. The terminal swaps that `code` + its secret `verifier` for a **token** — directly,
   server-to-server. Because the secret never travels through the browser, nothing
   sensitive is ever exposed in a URL or email.

The token is a JWT that *contains* the workspace's Management API key. The CLI reads it
out and saves it.

---

## 3. The flow, step by step

```
  TERMINAL (fingerprint CLI)                 BROWSER                     AUTH SERVER (mcpauth.fingerprint.com)
  --------------------------                 -------                     -------------------------------------
  1. make PKCE verifier (secret, local)
     + its SHA-256 challenge
  2. start loopback on 127.0.0.1:8976
  3. open browser -------------------------> /oauth2/authorize?          (discovered from
                                             client_id=... &              /.well-known/oauth-authorization-server)
                                             redirect_uri=127.0.0.1:8976 &
                                             code_challenge=... &
                                             state=... [&screen_hint=sign-up]
                                             4. you sign in / sign up
                                                + pick/complete workspace
                                             5. redirect back ---------->  issue one-time `code`
  6. loopback receives   <------------------ 127.0.0.1:8976/callback?code=...&state=...
     code (+ checks state matches)
  7. POST /oauth2/token -----------------------------------------------> exchange code + verifier
     { code, code_verifier, client_id }                                   for an access token (JWT)
  8. decode JWT:
       sub = "serverApiKey-managementApiKey-region"
       urn:fingerprint:sub_id = workspaceId
  9. save to ~/.config/fingerprint/auth.json
```

That's the whole thing. Steps 6–7 are the moment the browser "comes back to the terminal."

---

## 4. What code is involved (and what is NOT)

### `fingerprint-cli` — the only side with CLI-specific code

| File | What it does |
|------|--------------|
| `src/auth/browserLogin.ts` | The whole flow above. Makes the PKCE pair + `state`, discovers the endpoints from the issuer, starts the loopback (`127.0.0.1`, ports `8976–8980` tried in order), opens the browser to `/oauth2/authorize`, waits for the `code`, exchanges it for the token, decodes the workspace key out of the JWT, and calls `saveAuthState`. Login waits 5 min; **signup waits 20 min** (account creation + email confirmation + onboarding all happen in-browser). |
| `src/auth/tokenStore.ts` | Where the key is stored: `~/.config/fingerprint/auth.json` (perms `0600`). Holds `managementApiKey`, `workspaceId`, `region`, `managementApiUrl`. |
| `src/config/config.ts` | Per-environment URLs + the OAuth `oauthIssuer` and `oauthClientId`. Overridable via `FINGERPRINT_OAUTH_ISSUER` / `FINGERPRINT_OAUTH_CLIENT_ID` / `FINGERPRINT_ENV`. |
| `src/commands/auth.ts` | `login()` / `signup()` — both call `loginWithBrowser`, then chain into `integrate`. |
| `src/index.ts` | Wires up the `login` / `signup` commands. |

### `dashboard` and `mgmt-api` — **no CLI-specific code needed**

The CLI is "just another OAuth client" of the **already-deployed MCP auth server**. It
even registers itself via **Dynamic Client Registration** (`POST /oauth2/register`), so
no one has to hand-register a client. The token it receives is the *existing* MCP token —
the CLI parses it itself. **So logging in needs zero changes in the dashboard or mgmt-api.**

### The token contract

The access token is a JWT whose:
- **`sub`** is three dash-separated parts: `serverApiKey-managementApiKey-region`
  (region may itself contain dashes — keep the remainder after the 2nd dash).
- **`urn:fingerprint:sub_id`** claim carries the workspace id.

The CLI decodes this without verifying the signature (it came straight from the auth
server over TLS; downstream services verify it against the JWKS).

---

## 5. Signup is single-step (email confirmation does **not** break it)

`fingerprint signup` is the same flow with `screen_hint=sign-up`. A brand-new user has to
confirm their email and complete a first workspace, which takes a few minutes — so the
loopback stays open for 20 minutes.

The confirmation email opens a fresh tab, but the flow is **not** lost: the auth server's
page (`dashboard/mcp-auth?external_auth_id=…`) carries a **pendingRedirect** through
signup → email confirmation → workspace completion, and then redirects the browser back
to the CLI's loopback with the `code`. As long as the loopback is still listening, the CLI
finishes automatically. (Do **not** "fix" this by splitting signup into two steps — that
was tried and it *broke* signup, because nothing was listening on the loopback when the
redirect returned.)

---

## 6. Why it fails with `fetch failed` (and how to fix)

`fetch failed` is a Node `fetch()` throwing before it gets a response — almost always a
**DNS / reachability** problem, not an auth problem. Two places it happens:

**A) At login — the issuer host can't be reached.**
`browserLogin.ts` fetches `<oauthIssuer>/.well-known/oauth-authorization-server`. If
`oauthIssuer` points at a host that doesn't resolve (e.g. a wrong staging guess like
`mcpauth.fpjs.sh` → `NXDOMAIN`), you get `fetch failed` immediately.
→ **Fix:** point `oauthIssuer` at a real auth server. Prod is
`https://mcpauth.fingerprint.com`.

**B) After login, in the wizard — the Management API host can't be reached.**
The "Set up environment variables" step calls the Management API at
`auth.managementApiUrl`. If that host doesn't resolve (or is internal-only and you're not
on the VPN), the call throws `fetch failed` right after `Workspace region: …`.
→ **Fix:** set `managementApiUrl` to the correct host **and** be on a network that can
reach it.

### Environment notes

- **Production** works end-to-end from anywhere:
  - `oauthIssuer` = `https://mcpauth.fingerprint.com`
  - `managementApiUrl` = `https://management-api.fpjs.io`
- **Staging** has its own WorkOS AuthKit issuer (`https://scientific-cat-58-staging.authkit.app`)
  and its own CLI client id. It mints a **staging-scoped** key that authenticates against
  the staging Management API.
- The **staging public Management API** is `https://public-mgmtapi.fpjs.sh`, but it
  resolves to an **internal** load balancer (private `172.x` IPs) — reachable **only on
  the VPN / from inside the cluster.** From a plain public connection it times out
  (`fetch failed`). `public-mgmt-api.stage.fpjs.sh` is **not** a real host. So staging
  login + wizard only work end-to-end while you're on the VPN.

### Quick checklist when it fails

1. `curl <oauthIssuer>/.well-known/oauth-authorization-server` → should return JSON with
   `authorization_endpoint` + `token_endpoint`. If it can't resolve, your issuer is wrong.
2. `curl <managementApiUrl>/` → should answer (even a 401/404 is fine — it means the host
   is reachable). A **timeout** means internal-only host / not on VPN. `NXDOMAIN` means
   wrong hostname.
3. Are `oauthIssuer` and `managementApiUrl` from the **same** environment preset? Mixing a
   prod token with a staging API (or vice-versa) will authenticate-fail even when reachable.
4. Under the timeout? Login is 5 min, signup is 20 min.

---

## 7. Where the key is stored

One file: `~/.config/fingerprint/auth.json`, locked to `0600` (owner read/write only).

```json
{
  "managementApiKey": "…",
  "workspaceId": "sub_…",
  "region": "eu",
  "managementApiUrl": "https://management-api.fpjs.io"
}
```

- Written by `saveAuthState()` at the end of a successful login.
- Read by `fingerprint whoami` and before any wizard step that needs the key.
- Deleted by `fingerprint logout` (the key itself keeps existing in the workspace — revoke
  it from the dashboard's API-keys page if needed).
- The path is **not** per-environment, so a prod login and a staging login overwrite the
  same file — whichever you ran last wins.
