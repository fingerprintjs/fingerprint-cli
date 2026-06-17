# Fingerprint CLI — Production & Security Review

_Date: 2026-06-17 · Branch: `onboarding` · Scope: full `src/` (28 files)_

## Architecture in brief

Email/password (or a management API key) → tokens stored in `~/.config/fingerprint/auth.json` (chmod 600).
The wizard clones a **skills repo**, then runs a **Claude Agent SDK agent** with file-write access over the
user's repo, routing LLM calls through a **hosted gateway**. Package installs run host-side via `execFileSync`.

Severity ordering below: **Critical → High → Medium → Low**.

---

## Critical

### C1. Skills repo is an untrusted supply chain ending in `npm install` of attacker-chosen packages → RCE
- `skills.ts:15` defaults `SKILLS_REPO` to a **personal** repo (`github.com/sedyldz/fingerprint-skills`),
  `git clone`d and `git pull --ff-only` on **every run** (`skills.ts:29-44`) — no pinned commit, no signature,
  no integrity check. Whoever controls that repo controls what runs on every user's machine.
- Payload path: `skill.json` `packages` (`skills.ts:46-49`) → `installPackages` →
  `execFileSync(bin, [sub, ...pkgs])` (`runner.ts:280`). A malicious skills repo can name any npm package;
  `npm install <pkg>` runs that package's **postinstall script** = arbitrary code execution.
  `execFileSync` avoids *shell* injection, but the attacker-controlled package *name* is enough.
- Same repo supplies `SKILL.md`, loaded as **instructions to an agent that has Write access to the repo**
  (`runner.ts:90-106`). Compromise → silently backdoored source edits, no confirmation (see H1).
- `FINGERPRINT_SKILLS_REPO` is env-overridable; passed to `git clone` as a URL, so `ext::sh -c "…"` transport
  URLs let git itself execute commands.

**Fix:** org-owned repo; pin to commit/tag or vendor a verified copy; validate `packages` against an
allowlist (`@fingerprint/*` + known peers); stop auto-`pull`.

### C2. Hosted infra is personal, not org-owned
- LLM gateway defaults to `https://fingerprint-llm-gateway.sedanur-yildiz.workers.dev` (`llm.ts:10`) — a
  personal Cloudflare account. It's a credential broker: holds the Anthropic key, receives every user's
  Fingerprint session token. No SLA, single owner, no visible rate limiting → any logged-in user can drive
  unbounded Claude spend, and the agent is general-purpose (repurposable beyond integration).

**Fix:** move to org infra; add per-user rate/cost limits and abuse monitoring.

---

## High

### H1. Agent auto-applies file edits by default (no human in the loop)
`permissionOptions()` defaults to `permissionMode: 'acceptEdits'` with `Edit`/`Write` allowed
(`runner.ts:37-39`); `--interactive` is opt-in. Good: no `Bash`. But the **docs-fallback path** enables
`WebFetch`/`WebSearch` (`runner.ts:165`), so the agent reads arbitrary web pages and then has `Write` —
a prompt-injection → file-write chain, confined to cwd but able to plant a backdoor.
**Fix:** default to confirm-on-write (at least for the docs path).

### H2. Freshly minted secret key written to `.env` in the agent's cwd, with `Read` enabled
`provisionForRepo` writes `FINGERPRINT_SECRET_API_KEY` to `.env` (`provision.ts:171-177`); `runAgent` then runs
with cwd = repo and `Read` allowed. The only thing preventing the agent from reading `.env` and sending the
secret to the gateway/Anthropic is the prompt line *"Do NOT read or print .env"* (`runner.ts:128`) — a soft
control against an LLM.
**Fix:** deny-read `.env*` via a permission rule, not an instruction.

### H3. Fingerprint session token reused as gateway auth + injected into agent subprocess env
`llm.ts:24` sets `ANTHROPIC_AUTH_TOKEN: auth.accessToken` and spreads `...process.env` (`llm.ts:22`) into the
child. (a) A session credential crosses into the LLM trust domain — if the gateway logs `Authorization`, you
log user sessions. (b) The entire parent env (incl. `FINGERPRINT_API_KEY` and unrelated secrets) is handed to
the agent subprocess.
**Fix:** use a scoped/exchanged token for the gateway; pass a minimal env.

### H4. Env-var redirection enables credential capture / instruction injection
`--api-url` / `FINGERPRINT_API_URL` (`config.ts:1`) is where the CLI POSTs **email + password + tokens**. In a
shared/CI environment, anyone who can set that env redirects auth to a server they control. Same shape for
`FINGERPRINT_GATEWAY_URL` (token capture) and `FINGERPRINT_SKILLS_REPO` (injection, C1).
**Fix:** pin to known hosts or warn loudly on override.

---

## Medium

- **M1. Management API key handling** — `--api-key` (`index.ts:21`) carries workspace-admin scope; the inline
  flag lands in shell history and `ps`/process listings; CI logs may echo it. In-memory-only storage is good
  (`tokenStore.ts:17-23`) — document/encourage env-only, never the inline flag.
- **M2. Automated secret-key minting → key sprawl** — `createSecretKey` (`provision.ts:85-91`) mints a new
  `api` key whenever none is found in env; re-runs multiply secret keys and can hit the workspace key limit.
- **M3. CLI auto-accepts legal terms** — `workspaceStart` hardcodes `privacyPolicy: true, termsOfService: true`
  (`workspace.ts:41-42`), asserting consent without the user seeing it. Compliance sign-off needed.
- **M4. `.env` secrets risk being committed** — `credentialsStep` only *logs* "add to .gitignore"
  (`keys.ts:13`); it doesn't do it. Auto-append written files to `.gitignore`.

---

## Low

- **L1. SSO email/domain enumeration** — `/sso/auth` reveals whether SSO is enabled for an email (`auth.ts:123`).
- **L2. Possible bot-protection bypass** — CLI sends spoofable `X-Fingerprint-Client: cli` /
  `User-Agent: fingerprint-cli` (`client.ts:18-20`); README notes signup is gated by visitor-ID checks in prod.
  Ensure the server enforces checks regardless of these headers.
- **L3. `whoami` dumps the full user object** as JSON (`auth.ts:190`) — may expose more than intended.
- **L4. Plaintext token at rest** (`auth.json`, chmod 600) — acceptable but keychain is stronger; 401-refresh
  has no backoff and concurrent requests can race the refresh (`client.ts:25-28`, `47-55`).
- **L5. Dead reference** — `mcpToken` (`endpoints.ts:12`) is defined but unused; remove.

---

## mgmt-api endpoints to scrutinize

| Endpoint | Why it's exposed via the CLI |
|---|---|
| `POST /subscriptions/:id/tokens` | Auto-mints **secret** keys (`provision.ts:86`); key sprawl, secrets to plaintext `.env`. Highest-value endpoint hit. |
| `GET /subscriptions/:id/tokens` | Returns public/browser keys; confirm it never returns secret values. |
| `POST /subscriptions/start` | Creates workspaces and **auto-asserts ToS/privacy consent**. |
| `POST /signup`, `/signup/confirm`, `/signup/password_strength` | Unauthenticated; password sent to strength endpoint; verify server-side bot/visitor-ID protection isn't relaxed for the `cli` client header. |
| `POST /login`, `POST /sso/auth` | Brute-force / enumeration targets; ensure server rate-limits. |
| Any endpoint reachable with a **management key** | `--api-key` carries workspace-admin scope; risk is credential exposure, not the path itself. |

---

## Bottom line

Biggest production blockers: **supply chain (C1)** and **personal infrastructure (C2)** — both fully
exploitable as written. Next, the secret-key-in-cwd / token-reuse / auto-apply trio (H1–H3) are the design
points to harden before real users run this against their repos. The endpoints themselves aren't obviously
vulnerable from the client side — the risk is in *how* the CLI uses them (auto-minting keys, auto-accepting
terms, header-based trust).

### Suggested priority order to fix
1. C1 — pin/vendor skills repo + package allowlist
2. C2 — move gateway + skills repo to org-owned infra, add rate limits
3. H2 — deny-read `.env*` for the agent
4. H3 — scoped gateway token + minimal subprocess env
5. H1 — confirm-on-write default (at least docs path)
6. M4 — auto-`.gitignore` written `.env` files
