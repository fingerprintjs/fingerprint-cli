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
| `cyan`   | cyan                                  | Steps (`◇`), spinner frames, auth URL         |
| `green`  | green                                 | Success (`✔`)                                 |
| `yellow` | yellow                                | Warnings (`▲`)                                |
| `red`    | red                                   | Errors (`✖`)                                  |
| `magenta`| magenta                               | Verbose tool calls (`●`)                      |
| `dim`    | dim / faint                           | Info rail (`│`), tips, labels, secondary text |
| `bold`   | bold                                  | Tool names, `whoami` values                   |
| `brand`  | truecolor `#FF5A36` (Fingerprint orange) | Branded banner title (styling example)     |

### Status symbols (`src/wizard/log.ts`)

```
│  info     (dim)       continuing detail / narration
◇  step     (cyan)      a phase is starting
✔  success  (green)     something completed
▲  warn     (yellow)    non-fatal issue / review needed
✖  error    (red)       failure
●  tool     (magenta)   verbose-only agent tool call (+ bold name, dim detail)
```

### Integrate animation (`src/wizard/spinner.ts` + `animations/integrate.ts`)

Live multi-line redraw (TTY, non-`--verbose` only). Frames follow the
[ASCII Motion](https://ascii-motion.app) JSON export shape (pre-rasterized text lines + duration);
authored for that tool so they can be redesigned there and swapped in.

```
    ┌ · · · · · · · · · · · ┐
         · ( · ) ·
       ·     ◉     ·              ← brand-orange pulse (visitor “identify” rings)
         · ( · ) ·
    └ · · · · · · · · · · · ┘
◇ Setting up the integration  Fingerprint re-identifies returning visitors even after…
```

- Animation: 8 frames, ~100–120ms each, concentric scan around a core `◉`
- Status line: cyan `◇` + high-level activity + dim rotating tip (~every 5s)
- Agent narration (`│ …`) prints above the block; the block is cleared and redrawn underneath
- Cleared entirely when the agent finishes (success or error)

**Replacing the art:** open [ascii-motion.app](https://ascii-motion.app), design a ~29×5 loop,
Export → JSON (disable Include Empty Cells) or Text per frame, then update
`src/wizard/animations/integrate.ts`. Keep height small so the status line stays on-screen.

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

**Banner + waiting** (styling example applied):

```
Fingerprint · Sign in

◇ Opening your browser to sign in...
│ If it doesn't open, visit:
  https://…/oauth2/authorize?…
│ Waiting for you to finish in the browser — come back here when you’re done...
```

Signup adds:

```
│ Check your inbox and click the confirmation link, then finish setup in the browser.
```

(and banner subtitle `Create your account`; timeout is 20 minutes vs 5 for login.)

**On success** (when chained into integrate, the default for `login` / bare entry):

```
✔ Logged in successfully.
◇ Next: integrate Fingerprint into the current project.
```

Then the integrate flow runs.

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
workspace  sub_…
region     eu
```

(`workspace` / `region` dim; values bold.)

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

### `fingerprint integrate` — analysis block (`formatAnalysis`)

Always printed first (plain, no status symbols):

```
Repository: /path/to/repo
Layout: single app                    # or: monorepo / multiple apps

Detected apps:
  - .  [fullstack]  next, ts, pnpm
  - apps/api  [backend]  express, ts, npm
  # or:
  - (none — no package.json or python project found)

Frontend: next (.)
Backend:  express (apps/api)
# or: not found

Matched skills: fingerprint-nextjs
# or: No curated skill for this stack — a docs-based integration can be attempted (experimental).
# or: No supported app detected — nothing to integrate.
```

With `--analyze` (or unsupported stack with no frontend/backend), the command stops after this block.

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

## Styling example on this branch

`feat/cli-styling` (from `feat/cli-browser-auth`) adds a minimal custom look as a starting point:

1. **`color.brand`** — Fingerprint orange `#FF5A36`
2. **`banner(subtitle)`** — orange `Fingerprint · <subtitle>` before auth
3. Auth waiting / success / logout / `whoami` routed through `log.*` + styled labels instead of bare `console.log` / JSON
4. **Integrate ASCII animation** — multi-line “identify” pulse during the agent pass, in the
   [ASCII Motion](https://ascii-motion.app) export shape (`src/wizard/animations/integrate.ts`),
   so art can be redesigned there and dropped back in

Wizard status symbols (`◇`/`✔`/`▲`/`✖`/`│`/`●`) are unchanged; they already form a coherent system to extend.
