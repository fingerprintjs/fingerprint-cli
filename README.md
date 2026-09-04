# Fingerprint CLI

Add [Fingerprint](https://fingerprint.com) device intelligence to your app in one command.

The CLI detects your stack, provisions API keys for your workspace, and writes the integration
directly into your code — client-side identification, server-side verification, and a protected
action wired end to end.

## Quick start

From your project's root directory:

```bash
npx fingerprint
```

That's the whole thing. It works out where you are and takes you to the next step:

- **Not signed in?** It opens your browser to sign you in. New users sign up, pick a server region,
  and get a workspace in the same flow. Then it integrates Fingerprint into the current repo.
- **Already signed in?** It goes straight to integrating the current repo.

You do not need an Anthropic API key — the CLI routes its model calls through Fingerprint.

## What it does

1. **Signs you in** through your browser, and stores a workspace-scoped key locally.
2. **Analyzes your repo** to find the frontend and backend frameworks you're using.
3. **Provisions API keys** for your workspace and writes them to the right `.env` file, with the
   variable names your framework expects. New env files are added to `.gitignore` automatically.
4. **Writes the integration**, following the Fingerprint Get Started checklist one step at a time:
   it audits what's already in place, applies the first step that is missing — identify the
   visitor in the browser first; then, where you have a backend, verify the event against the
   Fingerprint API; then the custom subdomain, and so on — and tells you how to verify it. Test
   it, then pick the next step from the menu; if you choose server-side verification and your
   backend lives in another repo, it asks where. It works with the app you have rather than
   inventing a backend or a form.

Nothing is applied without your confirmation, and every change lands in your working tree for you to
review and commit.

## Supported stacks

**Frontend** — React, Vue, Angular, Svelte, Next.js

**Backend** — Node (Express, Fastify, Koa, NestJS, Hapi), Python (FastAPI, Django, Flask)

For any other stack, the CLI falls back to an integration that researches the Fingerprint docs before
editing your files. If it can't find an app it recognizes, it tells you rather than guessing.

## Commands

You rarely need these directly — `npx fingerprint` routes to the right one — but they're available:

| Command | What it does |
| --- | --- |
| `fingerprint` | The guided setup, start to finish: sign in, then integrate |
| `fingerprint integrate` | Add Fingerprint to the repo in the current directory |
| `fingerprint keys [public\|secret]` | Print an API key for your workspace (prompts if omitted) |
| `fingerprint login` / `signup` | Sign in or create an account through the browser |
| `fingerprint whoami` | Show the signed-in workspace |
| `fingerprint logout` | Delete the local credential |

### Options

`integrate` takes:

- `--path <dir>` — the repo to work on (default: the current directory)
- `--analyze` — report the detected stack and stop, without changing anything

And these work everywhere:

- `-y, --yes` — accept the confirmation prompts
- `--interactive` — ask before every individual file edit and package install
- `--verbose` — show each step in detail: file reads, edits, and tool calls
- `--ci` — non-interactive: never prompt, and fail fast if something is missing

## Signing in

`fingerprint login` opens your browser. You sign in there and return to your terminal — no password
is ever typed into the CLI.

Under the hood this is OAuth 2.0 Authorization Code with PKCE. The CLI briefly listens on a loopback
address (`127.0.0.1`) purely to catch the redirect back from your browser, and the secret that proves
the exchange never leaves your machine, so nothing sensitive travels in a URL or an email.

Because that redirect points at `127.0.0.1`, **your browser has to be on the same machine as the
CLI.** Over SSH or inside a container, forward the port first:

```bash
ssh -L 8976:127.0.0.1:8976 <host>
```

The CLI stores a **workspace-scoped API key** at `~/.config/fingerprint/auth.json`, readable only by
you. It's scoped to the workspace you signed into and cannot touch billing or other workspaces.
`fingerprint logout` deletes the local copy; to revoke the key itself, use the API Keys page in the
[Fingerprint dashboard](https://dashboard.fingerprint.com).

To work in a different workspace, run `fingerprint login` again and pick it in the browser.

## Your keys

Fingerprint uses two kinds of key, and the CLI keeps them separate for you:

- The **public key** goes in your frontend. It's safe to ship to the browser.
- The **secret key** stays server-side and is never written into frontend code or referenced by name
  in it.

The CLI writes both into `.env` files itself — they are never sent to a model, and `.env` files are
excluded from everything the integration step reads.

## Troubleshooting

A detailed run log is written to your system temp directory as `fingerprint-wizard.log` — never
inside your project. If an integration fails or does something unexpected, that log has the full
sequence of steps and is the best thing to attach to a bug report.

Run with `--verbose` to see the same detail live in your terminal.

## Telemetry

After you sign in, the CLI reports which commands you run and which frameworks were detected, so we
know which integrations to improve. It does not collect your code, file contents, file paths, or API
keys. Nothing is reported before you sign in.

## Support

- [Fingerprint documentation](https://dev.fingerprint.com/docs)
- [Report an issue](https://github.com/fingerprintjs/fingerprint-cli/issues)

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
