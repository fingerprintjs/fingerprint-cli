# Fingerprint CLI

CLI version of core Fingerprint dashboard onboarding workflows.

## Run it now (from source)

Not published to npm yet, so run it from a clone. The wizard's LLM calls are routed through a
hosted Fingerprint LLM gateway, so **you do not need an Anthropic API key**.

```bash
git clone https://github.com/fingerprintjs/fingerprint-cli/ fingerprint-cli
cd fingerprint-cli
pnpm install
pnpm run build
pnpm link --global  # makes the `fingerprint` command available globally
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
tab. No password is ever typed into the CLI.

Under the hood this is OAuth 2.0 Authorization Code with PKCE. The CLI briefly listens on a loopback
address — `127.0.0.1`, first free port in `8976–8980` — solely to catch the redirect back from the
browser, and the secret that proves the exchange (the PKCE verifier) never leaves your machine, so
nothing sensitive travels in a browser URL or an email. The listener is closed as soon as login
finishes.

Because that redirect points at `127.0.0.1`, **the browser has to be on the same machine as the CLI.**
Over SSH or inside a container, forward the port first — `ssh -L 8976:127.0.0.1:8976 <host>` — or the
redirect lands nowhere and the login waits until it times out.

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

## Logs

A verbose run log is written to your OS temp dir at `fingerprint-wizard.log` (never inside your
project), useful for debugging a failed integration.

## CLI output reference

See [docs/cli-output.md](docs/cli-output.md) for a catalog of every user-facing terminal message
and how it looks today (status symbols, colors, auth, integrate, errors).

## Environment variables

- `FINGERPRINT_ENV` (`production|staging`, default: `production`) — use `staging` for internal testing
- `FINGERPRINT_SKILLS_REPO` — skills repo to fetch (default: `https://github.com/fingerprintjs/skills`)
- `FINGERPRINT_SKILLS_DIR` — use a local skills checkout instead of fetching (for skill development)
- `FINGERPRINT_GATEWAY_URL` — override the hosted LLM gateway (for local gateway dev)

## License

The Fingerprint CLI is licensed under the [MIT License](LICENSE).

That covers the CLI's own source code. It does **not** cover the CLI's dependencies, which keep their
own terms. In particular, the agentic capabilities are powered by
[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk),
which is **not** open source — Claude is served under Anthropic's commercial license:

> © Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here:
> https://code.claude.com/docs/en/legal-and-compliance

So using the wizard means accepting Anthropic's Legal Agreements in addition to the MIT license
granted here. Every other production dependency is permissively licensed (MIT, ISC, BSD, Unlicense).

See [NOTICES.txt](NOTICES.txt) for the full third-party attribution list.
