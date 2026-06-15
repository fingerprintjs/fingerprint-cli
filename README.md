# Fingerprint CLI

CLI version of core Fingerprint dashboard onboarding workflows.

## Run it now (from source)

Not published to npm yet, so run it from a clone. The wizard's LLM calls are routed through a
hosted Fingerprint gateway (a Cloudflare Worker), so **you do not need an Anthropic API key**.

```bash
git clone <repo-url> fingerprint-cli
cd fingerprint-cli
npm install
npm run build
npm link            # makes the `fingerprint` command available globally
```

Then, from your project's root directory:

```bash
fingerprint            # figures out where you are: signup/login → workspace → keys → integrate
# or step through it:
fingerprint signup     # (or: fingerprint login)
fingerprint integrate  # analyze the current repo and apply the integration
```

> [!NOTE]
> The `integrate` apply step uses per-stack skills, which are fetched automatically from the public
> skills repo ([sedyldz/fingerprint-skills](https://github.com/sedyldz/fingerprint-skills)) and
> cached at `~/.config/fingerprint/skills` on first run — so no manual setup is needed (just `git`
> + network). Point at a different source with `FINGERPRINT_SKILLS_REPO`, or at a local checkout
> with `FINGERPRINT_SKILLS_DIR` while developing skills.
>
> Currently only a **React frontend + Node/Express backend** is supported; other stacks report
> "No integration skill matches yet."

## Quick start (once published)

A single command — it figures out where you are and takes you to the next step:

```bash
npx fingerprint
```

- Not signed in? It walks you through signup (or login) → workspace → API keys → integration.
- Signed in with a workspace? It integrates Fingerprint into the repo in the current directory.

Run it from your project's root directory.

If signup is blocked in production due to visitor ID checks, the CLI opens dashboard signup and then you can run `npx fingerprint` again to log in.

## CI / non-interactive

Pass `--ci` to never prompt (confirmations auto-proceed; missing input fails fast), and `--api-key`
to authenticate without an interactive login:

```bash
npx fingerprint integrate --ci \
  --api-key "$FINGERPRINT_API_KEY" \
  --subscription "$FINGERPRINT_SUBSCRIPTION_ID"
```

The API key is held in memory only — it is never written to disk. `--api-key` /
`--subscription` also read `FINGERPRINT_API_KEY` / `FINGERPRINT_SUBSCRIPTION_ID`, and `--ci` is
implied when `CI=true`.

## Commands

You rarely need these directly — `npx fingerprint` routes to the right one — but they're available:

- `fingerprint signup|login|logout|whoami`
- `fingerprint workspace ls|start|use`
- `fingerprint keys` — generate API keys and write them to `.env`
- `fingerprint integrate` — analyze the current repo and apply the Fingerprint integration

## Global flags

- `--ci` — non-interactive mode
- `--api-key <token>` — authenticate with a management API key
- `--subscription <id>` — workspace (subscription) id to use
- `--api-url <url>` — override the management API base URL
- `-y, --yes` — skip confirmation prompts

## Logs

A verbose run log is written to your OS temp dir at `fingerprint-wizard.log` (never inside your
project), useful for debugging a failed integration.

## Environment variables

- `FINGERPRINT_API_URL` (default: `https://mgmtapi.fpjs.sh`)
- `FINGERPRINT_REGION` (`us|eu|ap`, default: `us`)
- `FINGERPRINT_API_KEY` / `FINGERPRINT_SUBSCRIPTION_ID` — CI credentials
- `FINGERPRINT_SKILLS_REPO` — skills repo to fetch (default: `https://github.com/sedyldz/fingerprint-skills`)
- `FINGERPRINT_SKILLS_DIR` — use a local skills checkout instead of fetching (for skill development)
- `FINGERPRINT_GATEWAY_URL` — override the hosted LLM gateway (for local gateway dev)
