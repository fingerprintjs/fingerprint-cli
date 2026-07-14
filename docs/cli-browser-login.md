# CLI Browser Login — How It Works (Plain English)

This explains how `fingerprint login` signs you in through the browser, what code
was added across the three repos, and why it can get "stuck."

---

## 1. The problem it solves

The CLI needs a **Management API key** for your workspace so it can create keys and
environments on your behalf. We don't want you pasting keys by hand. So instead:

> You click "log in", your browser opens, you sign in like normal, and the CLI
> quietly receives a key for your workspace.

The tricky part: **the browser and the terminal are two separate programs.** The
terminal can *open* a browser, but it can't *see* what you did in it. They need a
drop box in the middle to pass the key.

---

## 2. The idea (a locker analogy)

Think of a gym locker:

1. The **terminal** brings a padlock with a random secret code (`hash`) and opens
   the browser pointed at a locker room, showing that code.
2. **You** sign in on the website. The website puts your workspace key **inside the
   locker** whose number is that code.
3. The **terminal** keeps trying its code on the locker every 2 seconds. The moment
   the key is inside, it grabs it — and the locker empties.

Nobody ever hands the key through the browser's address bar. The key only lives
inside the locker (the server), and only the terminal that knows the code can open it.

- **The locker room = the dashboard website** (where you log in).
- **The lockers = Redis** on the mgmt-api (the temporary mailbox).
- **The code = `hash`**, a big random string the CLI makes up.

---

## 3. The flow, step by step

```
  TERMINAL (fingerprint CLI)            BROWSER (dashboard)           SERVER (mgmt-api + Redis)
  --------------------------            -------------------           -------------------------
  1. make random `hash`
  2. open browser ----------------->    /cli-auth?hash=XYZ
                                        3. you sign in
                                        4. page auto-authorizes
                                           your current workspace
                                        5. POST /sso/cli-auth-accept ->  6. mint workspace mgmt key
                                           { hash, workspaceId }            store in Redis under `hash`
                                                                            (auto-expires in 10 min)
                                        7. shows "You're signed in"
  8. every 2s: GET /sso/cli-auth-poll?hash=XYZ  ------------------------>  9. is anything under `hash`?
                                                                            - no  -> { status: pending }
                                                                            - yes -> { status: complete, key }
                                                                                     and DELETE it (single use)
  10. got the key! save it locally
      and continue setup
```

That's the whole thing. The terminal just repeats step 8 until the server says
"complete."

---

## 4. What code was added, per repo

### Repo A — `fingerprint-cli` (the terminal side)

| File | What it does |
|------|--------------|
| `src/auth/browserLogin.ts` | The whole flow above: makes the `hash`, opens the browser, then loops calling the poll endpoint every 2s until it gets the key (or times out after 5 min). Saves the key with `saveAuthState`. |
| `src/api/client.ts` | A tiny HTTP helper (`ApiClient`) used for the one public call — the poll. It unwraps the server's `{ ok, data }` envelope. |
| `src/config/config.ts` | Holds the URLs per environment (`apiUrl` = where to poll, `dashboardUrl` = where to open the browser). **These two must belong to the same environment.** |
| `src/commands/auth.ts` | `login()` — browser-only now. Calls `loginWithBrowser`, then continues setup. |
| `src/index.ts` | Wires up the `login` command / default flow. |

The key contract lives as a comment at the top of `browserLogin.ts`:

```
open: <dashboardUrl>/login?redirect_to=<urlenc('/cli-auth?hash=<hash>')>
poll: GET <apiUrl>/sso/cli-auth-poll?hash=<hash>
      -> { status: 'pending' } | { status: 'complete', managementApiKey, workspaceId, region }
```

### Repo B — `mgmt-api` (the server + mailbox)

| File | What it does |
|------|--------------|
| `packages/api/src/sso/services.ts` | The mailbox. `storeCliAuthCredential` puts the key in Redis under the `hash` with a 10-min expiry. `pollCliAuthCredential` uses `getDel` to read it **once** and delete it. |
| `packages/api/src/sso/handlers.ts` | Two handlers. `handleCliAuthAccept` (called by the browser, logged in) mints the workspace key via `createCliToken` and stores it. `handleCliAuthPoll` (called by the CLI, public) returns `pending` or `complete`. |
| `packages/api/src/sso/routes.ts` | Registers `POST /sso/cli-auth-accept` and `GET /sso/cli-auth-poll`, both rate-limited. |
| `packages/api/src/sso/validators.ts` | Shapes of the request/response so bad input is rejected. |
| `packages/api/src/middleware/auth.ts` | Makes `cli-auth-accept` require a login session (so we know who you are), while `cli-auth-poll` stays public (the CLI has no session — only the secret `hash`). |
| `packages/common/src/redis/keys.ts` | Adds the `cli_auth_sessions` Redis namespace (the "locker bank"). |
| `packages/api/src/tokens/service.ts` | `createCliToken` — mints the actual workspace-scoped Management key (and can roll it back if storing fails). |

### Repo C — `dashboard` (the web page you see)

| File | What it does |
|------|--------------|
| `src/routes/_authenticated/cli-auth.tsx` | The `/cli-auth` route. Reads `hash` from the URL. It's under `_authenticated`, so you must be logged in to reach it (the login page sends you here afterward). |
| `src/features/cliauth/CliAuthPage.tsx` | The page itself. **No button** — it auto-authorizes your *current* workspace on load, calls accept, then shows "You're signed in to the Fingerprint CLI." New users go through onboarding first, then land back here. |
| `src/const/api.ts` + `src/hooks/api/auth.ts` | Declares the `cliAuthAccept` endpoint and the `useCliAuthAcceptMutation` hook the page uses. |

---

## 5. Why it can get "stuck" (and how to fix)

"Stuck" almost always means: **the browser dropped the key in one locker bank, but the
terminal is checking a different locker bank.** Same code — wrong wiring.

The single most common cause, and the one that bit us:

- The **CLI polls** the server at its `apiUrl`.
- The **dashboard drops the key** at *its* configured API base (`REACT_APP_API_URL`
  in the dashboard's `.env.local`).
- If those two point at **different mgmt-api servers**, they have **different Redis**.
  The dashboard's POST succeeds (browser shows "signed in"), but the CLI polls a Redis
  that never got the key → it waits forever.

Note: a wrong *path* would 404 and error immediately. A wrong *server* returns a valid
`{ status: 'pending' }` forever — which is exactly why it hangs instead of failing.

**Fix:** make both sides point at the same mgmt-api.

```bash
# Point the CLI at the same mgmt-api the dashboard writes to (check dashboard/.env.local)
FINGERPRINT_API_URL=http://localhost:3001 fingerprint login
```

**Also important — each login is a fresh locker.** Every time you run `fingerprint
login`, the CLI makes a **new** `hash`. You must complete the browser step for *that*
run. Re-running the CLI and then looking at an **old** "You're signed in" tab does
nothing — that old tab authorized an old hash. Let the CLI open a fresh tab (or use
the printed URL) and let it auto-authorize again.

### Quick checklist when it hangs

1. Is a mgmt-api actually running at the CLI's `apiUrl`?
   `curl "http://localhost:3001/sso/cli-auth-poll?hash=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"`
   → should return `{"ok":true,"data":{"status":"pending"}}`.
2. Does the **dashboard's** `REACT_APP_API_URL` point at that **same** server?
   (`.env.local` overrides `.env` — check the one that wins.)
3. Did you complete the browser step for the **current** run (fresh tab), not an old one?
4. Under 10 minutes elapsed? The stored key expires after that.
```
```

---

## 6. Why Redis (not a database)?

The key is **throwaway data with three needs**, and Redis nails all three in one line each:

- **Auto-expire** — it should disappear if you never finish (`EX: 600` = 10 min).
- **Read once** — `getDel` reads and deletes atomically, so a stolen `hash` can't be
  reused after the CLI picks the key up.
- **Fast + tiny** — it's a 3-field blob living for seconds. A real DB table would be
  overkill and need a cleanup job.

Redis is the natural fit for a short-lived, self-cleaning, read-once mailbox.
