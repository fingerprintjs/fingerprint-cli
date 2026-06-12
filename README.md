# Fingerprint CLI

CLI version of core Fingerprint dashboard onboarding workflows.

## Quick start

One command — it figures out where you are and takes you to the next step:

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
