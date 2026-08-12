# CLI output catalog

Inventory of every user-facing terminal (and browser-callback) message the Fingerprint CLI
can print today, and how each one looks. Use this as a baseline when redesigning the CLI’s
visual language.

Color is applied only when stdout is a TTY and `NO_COLOR` is unset (`src/utils/color.ts`).
Piped / CI output is plain text with the same symbols and wording.

---

## Visual system (current)

### Colors (`src/utils/color.ts`)

| Token    | ANSI / effect                         | Used for                                      |
|----------|---------------------------------------|-----------------------------------------------|
| `cyan`   | cyan                                  | Steps (`◇`), spinner frames                   |
| `green`  | green                                 | Success (`✔`)                                 |
| `yellow` | yellow                                | Warnings (`▲`)                                |
| `red`    | red                                   | Errors (`✖`)                                  |
| `magenta`| magenta                               | Verbose tool calls (`●`)                      |
| `dim`    | dim / faint                           | Info rail (`│`/`└`), labels, URLs, “not found”|
| `bold`   | bold                                  | Step titles, app names, key values            |
| `brand`  | `#FF5A36` (Fingerprint orange)        | Branded banner title                          |
| `badge`  | `bgCyan` + `black`                    | Phase headings (`log.heading`)                |
| `link()` | dim                                   | Clickable URLs when the terminal supports it  |

### Status symbols (`src/wizard/log.ts`)

Clack-style hierarchy: bold section titles, a dim rail grouping detail, blank lines between
blocks. Absence is dim; emphasized details (language, package manager, framework) use cyan.

```
   heading  (bg cyan + black) phase badge; next step connects with │
◇  step     (cyan + bold)   section header (leading blank line)
│  info     (dim rail)      detail under the current section
│  kv                     aligned `Label      value` under the rail
✔  success  (green)         completed outcome
▲  warn     (yellow)        inline warning / failure section title
✖  error    (red)           failure
└  end      (dim)           closes the final section
●  tool     (magenta)       verbose-only agent tool call (+ bold name, dim detail)
```

### Integrate status line (`src/wizard/spinner.ts`)

One line, redrawn in place. Live TTY only, so it's skipped under `--verbose`, `--ci`, and piped or
redirected output (those get the plain `│ …` log lines instead).

```
⠹ Setting up the integration  Fingerprint re-identifies returning visitors even after…
```

- Loader: brand-orange `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, one frame every 80ms. The cyan `◇` stays on static
  `log.step` headers only.
- Then the high-level activity, then a dim tip that rotates every 5s and is truncated to the
  terminal width (dropped entirely under ~12 columns of room)
- Agent narration (`│ …`) prints above the line; the line is cleared and redrawn underneath
- Cleared when the agent finishes (success or error)

### Branded banner (`banner()` in `color.ts`) — styling example

Printed at the start of login / signup:

```
Fingerprint · Sign in
```

`Fingerprint` is bold brand-orange; `·` and the subtitle are dim.

### Prompts (`@inquirer/prompts` + `src/utils/prompt.ts`)

Interactive selects / confirms use Inquirer’s default look (not custom-styled yet). Free-text
prompts from `text()` print `Message: ` with the cursor after the colon.

---

## Commands and their output

### `fingerprint` / `fingerprint setup` (default onboarding)

| Condition | Output |
|-----------|--------|
| Not authenticated, interactive | Account select prompt → auth flow → integrate |
| Not authenticated, `--ci` | Error: `Not authenticated. Run \`fingerprint login\` first.` |
| Authenticated | Same as `fingerprint integrate` |

**Account select** (when intent is not forced):

```
? Do you already have a Fingerprint account?
❯ Yes — log in
  No — create one
```

---

### Auth: `login` / `signup` / browser OAuth (`browserLogin.ts`)

When auth chains into integrate (the default for `login` / bare entry / `setup`), the
`integrate` phase badge opens the sequence before Sign in:

```
 integrate
│
◇ Sign in
│ If the browser doesn’t open, visit:
│   https://…/oauth2/authorize?…
│ Waiting for you to finish in the browser. Please return here when you’re done...
✔ Signed in  workspace <id>
```

Signup uses `◇ Sign up` and adds:

```
│ Check your inbox and click the confirmation link, then finish setup in the browser.
```

(timeout is 20 minutes vs 5 for login.) Then the integrate flow continues under the same heading
(`skipHeading` so the badge is not printed twice).

**Browser callback HTML** (loopback `http://127.0.0.1:<port>/callback`):

Success:

```
You’re signed in ✓
You can close this tab and return to your terminal.
```

Failure:

```
Sign-in failed
Return to your terminal and try again.
```

**Auth errors** (thrown → top-level `console.error(err.message)`):

| Message |
|---------|
| `CLI login is not configured yet (missing OAuth issuer/client id). Set FINGERPRINT_OAUTH_ISSUER and FINGERPRINT_OAUTH_CLIENT_ID.` |
| `Couldn’t reach the login service (HTTP <n>). Please try again in a few minutes.` |
| `Login service returned unexpected metadata. Please try again in a few minutes.` |
| `Couldn’t open a local port for login (tried 8976, 8977, 8978, 8979, 8980).` |
| `Authorization was denied (<error>).` |
| `No authorization code returned.` |
| `State mismatch — aborting for safety.` |
| `Timed out after <n> minutes. Run \`fingerprint login\` again.` (or `signup`) |
| `Login failed while exchanging the code (HTTP <n>). Run \`fingerprint <intent>\` again.` |
| `Login token was not in the expected format. Run \`fingerprint login\` again.` |
| `Login succeeded but no API key was returned. Run \`fingerprint login\` again.` |
| `Malformed token from WorkOS.` |
| `Authentication required.` (`ensureAuth` after a failed login) |

---

### `fingerprint logout`

```
│ Logged out. (The CLI API key remains in your workspace — revoke it from the dashboard if needed.)
```

---

### `fingerprint whoami`

Authenticated (styling example — no longer raw JSON):

```
subscription  sub_…
region        eu
email         you@example.com
```

(labels dim; values bold. `email` is printed only when the login id_token carried an email claim.)

Not authenticated:

```
Not logged in
```

---

### `fingerprint keys [public|secret]`

Interactive type pick (when type omitted, non-CI):

```
? Which API key do you need?
❯ Public — browser / JS Agent (client-side)
  Secret — server-to-server verification
```

Success: prints the key alone on stdout (no symbol) — intentional for piping/copying.

Errors:

| Message |
|---------|
| `Not logged in. Run: fingerprint login` |
| `No public API key found in this workspace.` |
| `No Server API key found. Run \`fingerprint login\` again.` |
| `Unknown key type "<kind>". Use "public" or "secret".` |
| `Specify the key type in non-interactive mode: fingerprint keys <public\|secret>` |

---

### `fingerprint integrate` — analysis block (`printAnalysis`)

`integrateCommand` opens with the phase badge, then the analysis step (and any prior Sign in
when auth chained in). Direct `fingerprint integrate` when already logged in:

```
 integrate                                  # cyan badge (bgCyan + black)
│
◇ Analyzing project
│ Repository  ~/path/to/repo
│ Layout      monorepo · pnpm workspace     # or: single app
│
│ Apps found
│   fingerprint-cli  TypeScript · pnpm · framework not detected
│   apps/api         TypeScript · npm · express
│
│ Frontend    not found                     # or: next (.) — framework cyan, path dim
│ Backend     not found
│ Skills      fingerprint-nextjs            # only when curated skills match
```

Root app name uses the directory basename (not bare `.`). Missing signals are dim;
detected language / package manager / framework are cyan.

With `--analyze`, the command stops after this block.

**Unsupported stack** (no frontend/backend) adds a failure block:

```
▲ No supported app to integrate
│ No frontend or backend framework we can wire up was found in this repo.
│
│ Try:
│   fingerprint integrate --path <dir>  point at an app directory
│   fingerprint --help                  see available commands
│
│ Docs  https://dev.fingerprint.com/docs
└
```

---

### Integrate — provision (`provision.ts`)

```
◇ Set up environment variables
│ Workspace region: eu
│ Using existing Public API key.
│ Reusing existing Secret API key from env.     # or: Using Server API key from login.
✔ Wrote VITE_FINGERPRINT_PUBLIC_API_KEY, VITE_FINGERPRINT_REGION → ./.env
✔ Added to .gitignore: .env
▲ Make sure these backend(s) load .env (dotenv): api
▲ No Server API key available from login — skipping backend secret.
▲ /absolute/path/.env is outside this repo — add it to that project's .gitignore manually.
```

---

### Integrate — apply confirmation & agent

**Curated skill path:**

```
? Integrate Fingerprint into this repo (fingerprint-react + fingerprint-node)? (edits files) (Y/n)
◇ Apply integration
◇ Applying fingerprint-react + fingerprint-node in /path/to/repo
```

Default (TTY, non-verbose): spinner while the agent runs; agent narration appears as dim `│` lines above the spinner. On finish:

```
✔ Agent finished applying the integration.
```

On agent failure:

```
✖ Agent did not complete: <reason>
```

**`--verbose`**: each tool call streams as:

```
● Read src/App.tsx
● Edit src/App.tsx
● Glob **/*.{ts,tsx}
```

**No curated skill, but stack detected (docs fallback):**

```
▲ No curated skill for this stack (astro + express).
? Attempt an experimental, docs-based integration? (researches Fingerprint docs, then edits files) (Y/n)
◇ Researching Fingerprint docs and applying integration
…
▲ Experimental integration applied from docs — review the changes and install any dependencies it listed.
```

**Nothing to do:**

```
│ No Fingerprint integration is available for this stack yet.
```

**Package install** (after a successful curated apply):

```
◇ Installing @fingerprint/react@latest in . (pnpm)
✔ Installed in .
```

or

```
▲ Install failed in . — run manually: pnpm add @fingerprint/react@latest
▲ Skipped — install manually: …   # if --interactive and user declines
```

(`stdio: 'inherit'` on the package manager — npm/pnpm/yarn output appears interleaved.)

**`--interactive` edit gate:**

```
? Allow the wizard to edit src/App.tsx? (Y/n)
? Allow the wizard to create/overwrite src/fingerprint.ts? (Y/n)
```

---

### Integrate — follow-up other projects

Only when interactive (not `--ci` / `--yes`):

Frontend-only repo:

```
│ Your frontend can now identify visitors — but Fingerprint only stops fraud once a backend
verifies those events server-side. Want to set it up in your backend too?
? Point me to your backend project? (Y/n)
Path to the project (e.g. ../api) — blank to skip:
```

Backend-only: mirrored copy about needing a frontend (`../web`).

Both covered:

```
? Set up Fingerprint in another project too? (y/N)
```

Bad path / unsupported:

```
▲ No directory found at "../nope".
▲ No supported app detected there — skipping.
```

Then `formatAnalysis` + provision/apply for the target, same as above.

---

### Unknown command (`index.ts`)

```
Unknown command "xyzzy".
Did you mean "keys"?          # only when edit-distance suggests a plausible typo

Run `fingerprint --help` to see the available commands.
```

(`process.exitCode = 1`)

---

### Help (`commander`)

`fingerprint --help` / `fingerprint <cmd> --help` — standard Commander usage text (commands,
global flags `--ci`, `-y/--yes`, `--verbose`, `--interactive`). Not custom-styled.

---

### Top-level errors

Any thrown `Error` from a command is printed as:

```
<err.message>
```

via `console.error`, with `exitCode = 1`. No status symbol.

---

## Debug / side-channel output

| Channel | Location | Contents |
|---------|----------|----------|
| Verbose run log | OS temp `fingerprint-wizard.log` | Teed copies of `log.*` lines (`info`/`step`/`ok`/`warn`/`error`/`tool`) |
| Package manager | inherited stdio | npm/pnpm/yarn/bun install progress |
| Browser tab | HTML callback page | Sign-in success/failure (see above) |

---

## Visual hierarchy notes

1. **`color.brand`** — Fingerprint orange `#FF5A36`
2. **`banner(subtitle)`** — orange `Fingerprint · <subtitle>` before auth
3. Auth / analysis / provision / apply go through `log.*` (step → rail detail → success/warn)
4. Unsupported stacks end with `printFailure` (reason + recovery commands + docs + `└`)
5. **Integrate status line** — brand-orange loader + activity + rotating tip during the agent pass
   (`src/wizard/spinner.ts`)
