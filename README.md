# Fingerprint CLI

CLI version of core Fingerprint dashboard onboarding workflows.

## Run it now (from source)

Not published to npm yet, so run it from a clone. The wizard's LLM calls are routed through a
hosted Fingerprint LLM gateway, so **you do not need an Anthropic API key**.

```bash
git clone https://github.com/fingerprintjs/fingerprint-cli/ fingerprint-cli
cd fingerprint-cli
npm install
npm run build
npm link            # makes the `fingerprint` command available globally
```

Then, from your project's root directory:

```bash
fingerprint            # figures out where you are: login → integrate
# or step through it:
fingerprint login      # sign in through the browser
fingerprint integrate  # analyze the current repo and apply the integration
```

> [!NOTE]
> The `integrate` apply step uses per-stack skills, which are fetched automatically from the public
> skills repo ([fingerprintjs/skills](https://github.com/fingerprintjs/skills)) and
> cached at `~/.config/fingerprint/skills` on first run — so no manual setup is needed (just `git`
> + network). Point at a different source with `FINGERPRINT_SKILLS_REPO`, or at a local checkout
> with `FINGERPRINT_SKILLS_DIR` while developing skills.
>
> Curated skills cover **React, Vue, Angular, Svelte, and Next.js** frontends and **Node** (Express,
> Fastify, Koa, NestJS, Hapi) and **Python** (FastAPI, Django, Flask) backends. For any other detected
> stack the wizard falls back to an experimental, docs-based integration that researches the
> Fingerprint docs before editing files. If nothing is detected, it reports that no integration is
> available yet.

## Quick start (once published)

A single command — it figures out where you are and takes you to the next step:

```bash
npx fingerprint
```

- Not signed in? It opens the browser to sign you in (new users sign up and set up a workspace
  there), then integrates Fingerprint into the repo in the current directory.
- Already signed in? It goes straight to integrating the current repo.

Run it from your project's root directory.

## Signing in

`fingerprint login` opens your browser to the Fingerprint dashboard. Sign in there — **new users sign
up, pick a server region, and get a workspace** in the same flow — and once you authorize, the CLI
(which has been waiting) picks up the credential automatically; return to your terminal and close the
tab. No password is ever typed into the CLI, and there's no local server or port involved, so it works
over SSH and in containers too.

The CLI stores a **workspace-scoped API key** for the workspace you signed into, at
`~/.config/fingerprint/auth.json` (mode `0600`). That key is what `keys` and `integrate` use to talk
to Fingerprint; it can't touch billing or other workspaces. `fingerprint logout` deletes the local
copy — revoke the key itself from the dashboard's API Keys page if you need to.

To work in a different workspace, run `fingerprint login` again and choose it in the browser.

## Commands

You rarely need these directly — `npx fingerprint` routes to the right one — but they're available:

- `fingerprint login | logout | whoami`
- `fingerprint keys [public|secret]` — generate/fetch an API key for your workspace and print it
  (prompts for the type if omitted). `integrate` is what writes keys into your `.env`.
- `fingerprint integrate` — analyze the current repo and apply the Fingerprint integration

## Global flags

- `-y, --yes` — skip confirmation prompts
- `--verbose` — show the agent's individual steps (file reads, edits, tool calls)
- `--interactive` — ask before each file edit and package install

## Telemetry

Signed-in runs report which command was run, so we can see which parts of the CLI people actually
use. That is the whole payload: the command name, attributed to the workspace your API key is
already scoped to. No arguments, file paths, file contents, keys, or error output, and nothing is
written to your machine to recognize you. Runs before you sign in send nothing at all.

Turn it off by setting `DO_NOT_TRACK` to any non-empty value other than `0`:

```bash
export DO_NOT_TRACK=1
```

## Logs

A verbose run log is written to your OS temp dir at `fingerprint-wizard.log` (never inside your
project), useful for debugging a failed integration.

## Environment variables

- `FINGERPRINT_ENV` (`production|staging`, default: `production`) — use `staging` for internal testing
- `FINGERPRINT_SKILLS_REPO` — skills repo to fetch (default: `https://github.com/fingerprintjs/skills`)
- `FINGERPRINT_SKILLS_DIR` — use a local skills checkout instead of fetching (for skill development)
- `FINGERPRINT_GATEWAY_URL` — override the hosted LLM gateway (for local gateway dev)
- `DO_NOT_TRACK` — set to any non-empty value other than `0` to turn off telemetry
