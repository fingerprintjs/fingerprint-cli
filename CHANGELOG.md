# fingerprint

## 0.2.4

### Patch Changes

- In the wizard's custom subdomain step, when the DNS provider supports Domain Connect the CLI offers to open the provider and let it add the DNS records, then waits for validation. The run reports it on `cli_command_run` as `subdomain_dns: domain_connect` with `subdomain_provider`. ([14bb04f](https://github.com/fingerprintjs/fingerprint-cli/commit/14bb04f254712336d0fbe822a2329c149795e08c))
- `fingerprint subdomains connect <id-or-hostname>` adds a pending subdomain's DNS records through the DNS provider (Domain Connect) and verifies when the provider redirects back. `--no-open` prints the link instead of opening the browser; `--json` prints the link and exits. ([cdcc3f2](https://github.com/fingerprintjs/fingerprint-cli/commit/cdcc3f213532397f4bde1e2cb9d5a44dc0e25fad))

## 0.2.3

### Patch Changes

- Server-side verification counts as done only when the backend's code has an actual import of the server SDK. A comment that mentions the package, or a commented-out import, doesn't count. ([14015be](https://github.com/fingerprintjs/fingerprint-cli/commit/14015be7b2b68cafcfe4b0fd1d847857549b457d))
- Inside the wizard's subdomain step, the agent's `verify_subdomain` tool now only accepts the subdomain being set up, like `create_subdomain` already did. Another subdomain's id is looked up and refused before any verification is requested. ([2b94804](https://github.com/fingerprintjs/fingerprint-cli/commit/2b9480494deb125403b88440c406fdcff7dd7898))

## 0.2.2

### Patch Changes

- The documentation link the CLI prints points at `https://docs.fingerprint.com`. ([380fc04](https://github.com/fingerprintjs/fingerprint-cli/commit/380fc04d52d6919304899b28abdccc33d8eb4bb5))
- `integrate` now recognizes browser code with no framework SDK and applies the `fingerprint-javascript` skill, instead of reporting that no integration is available. This covers a bundled app with no framework dependency (detected from its `index.html` entry), Solid, Lit, Alpine, htmx and jQuery, a static site with no `package.json` at all, and a Node server's plain `public/index.html` (detected as a static frontend alongside the backend, also when the server's `package.json` lists a no-bundler library such as jQuery, htmx or Alpine) — where the public key and region are handed to the integration directly on every step, since there is no env file to read them from and no manifest to install into. A static site whose workspace has no enabled public key stops before the agent runs instead of getting a placeholder written into the page.

  A single `package.json` that holds both halves of the stack is now recognized as its own backend. Previously `integrate` only ever looked for a separate backend package, so a repo with react + express (or a Next.js app, which is its own server) resolved the frontend skill alone, never marked server-side verification as done, and asked for a backend repo path when the user picked that step. The server skill, the secret key and the verification step now all land in the app that's already there. Server-side verification counts as done once the backend's code imports the server SDK; the dependency alone doesn't, since the first step installs every skill's packages. ([47c05fe](https://github.com/fingerprintjs/fingerprint-cli/commit/47c05feb8fc63b1e9f9ccdbd1ddf5e48340bc0bb))

## 0.2.1

### Patch Changes

- Analytics requests get more time: 2 seconds for the events sent while a command runs and 5 seconds for `cli_command_run`, up from 1 second for all of them. The endpoint regularly took longer than a second from a cold process, so a good share of `cli_command_run` events were being dropped silently. ([58136db](https://github.com/fingerprintjs/fingerprint-cli/commit/58136db162899e04b6ab66874d15e1050e1b6b1f))
- `cli_command_run` now describes the wizard run: `wizard_steps` lists the choices in order, and when the run touched a custom subdomain it also carries `subdomain_outcome`, `subdomain_resumed` and `subdomain_dns`. `integrate_status` can be `waiting` for a run that ends with DNS records still pending. The Management API has to accept the new values before the CLI sends them. ([bff98ff](https://github.com/fingerprintjs/fingerprint-cli/commit/bff98ffe34fe5acc4b9b8b2d354cfad589b27106))

## 0.2.0

### Minor Changes

- The integration wizard can now set up a custom subdomain: the agent lists, creates and verifies it through Fingerprint tools, and a pending subdomain leaves the step waiting instead of done. ([c70a2ed](https://github.com/fingerprintjs/fingerprint-cli/commit/c70a2ed23b19c6ff4f34db2151c2461a83205d16))

### Patch Changes

- Add commands to create, list, inspect, verify, and delete custom subdomains through the Management API.
  Accept hostnames as well as IDs, show DNS setup guidance, and list subdomains when no operation is given. ([1ce0f2a](https://github.com/fingerprintjs/fingerprint-cli/commit/1ce0f2ab57f1798994bbabcbac2f61ced6970621))

## 0.1.2

### Patch Changes

- A mistyped command no longer reports a `cli_run_started` event, which it used to file as a bare `fingerprint` run. It still reports `cli_command_run` with `command: unknown`, and a signed-in run now includes what was typed, so the error logs show which command people tried. ([912e19a](https://github.com/fingerprintjs/fingerprint-cli/commit/912e19a4ab1940f11ebaeb113da79a50fb526ffc))

## 0.1.1

### Patch Changes

- A failed run now reports why. `cli_command_run` carries `error_code`, a short identifier for the kind of failure (skills fetch, install, agent, missing session, unknown command), plus the error message. Previously a failure reported `status: error` and nothing else. ([190ce43](https://github.com/fingerprintjs/fingerprint-cli/commit/190ce43a31daead1bacd7696402afde12673e72c))

## 0.1.0

First release of the Fingerprint CLI. Run `npx fingerprint` from your project's root to add Fingerprint device intelligence to your app.

The CLI signs you in through your browser, detects your frontend and backend frameworks (React, Vue, Angular, Svelte, Next.js; Node with Express, Fastify, Koa, NestJS or Hapi; Python with FastAPI, Django or Flask), provisions API keys for your workspace and writes them to the right `.env` file, then writes the integration by following the Fingerprint Get Started checklist one step at a time: identify the visitor in the browser, verify the event server-side where you have a backend, then the remaining protection steps, telling you how to verify each one. Nothing is applied without your confirmation, and every change lands in your working tree for review.

## 0.1.0-alpha.4

### Minor Changes

- The integration is now driven by the `fingerprint-get-started` orchestrator skill instead of a fixed hand-written target: the agent audits what's already done, applies only the Quick start steps that are missing (frontend identification, and server-side verification where a backend exists), and never invents a backend or a form the repo doesn't have. The run then ends with how to verify — the repo's own dev command and a link to your Get Started page in the dashboard, which marks step 1 complete when the first event arrives — and nothing else: no checklist of its own, no claims about which step is done, and no "set up the other side / another project?" prompt. ([3e25d52](https://github.com/fingerprintjs/fingerprint-cli/commit/3e25d52b53313d6cf9a389d5017d5912bf20daf5))

### Patch Changes

- pnpm no longer fails the run over blocked install scripts. On pnpm 10.5+ the CLI approves the build scripts of the packages it installs (`--allow-build`), so the install just succeeds; on older pnpm 10 the package is reported as installed with its optional scripts skipped, instead of as a failed integration. ([6a52063](https://github.com/fingerprintjs/fingerprint-cli/commit/6a52063516e705f5fd23dbd389b9b8af4040bb26))
- The Get Started skill drives the integration run, one checklist step at a time. The agent completes one step (the first not done on the first run, then the one you pick), tells you how to verify it, and stops; only its final message is shown, with the working commentary kept in the debug log. The CLI then asks you to test the step and choose what's next: server-side verification (asking where the backend is if it lives in another repo), the custom subdomain, or the remaining steps. The feature skills the orchestrator dispatches to (proxy, rules, tagging, request filtering, smart signals) are installed alongside it so every step it names can be applied. ([6a52063](https://github.com/fingerprintjs/fingerprint-cli/commit/6a52063516e705f5fd23dbd389b9b8af4040bb26))

## 0.1.0-alpha.3

### Patch Changes

- Report runs that never sign in, so the onboarding funnel has a denominator. A run with no key
  relays through the Management API's unauthenticated analytics route instead of reporting nothing. ([9cb76b9](https://github.com/fingerprintjs/fingerprint-cli/commit/9cb76b9c1a3b4e98d1d3e654d4361cb25d33ed05))

## 0.1.0-alpha.2

### Patch Changes

- A failed dependency install now fails the run (exit 1) instead of warning and reporting the integration as applied. pnpm's blocked-build-scripts failure gets a specific remediation (`pnpm approve-builds`), and declining an install in `--interactive` mode still exits cleanly — it's a choice, not a failure. ([36d3a87](https://github.com/fingerprintjs/fingerprint-cli/commit/36d3a8767c19fed080435f60da3b1423e65d7f0f))

## 0.1.0-alpha.1

### Patch Changes

- Report the installed CLI version consistently (banner, --version, and User-Agent header) by sourcing it from package.json at runtime. ([740db0b](https://github.com/fingerprintjs/fingerprint-cli/commit/740db0b3b6449109db0aea84d7e9377e2224de59))

## 0.1.0-alpha.0

### Minor Changes

- First release of the Fingerprint CLI, replacing the `0.0.2` placeholder package on npm. ([29e09ad](https://github.com/fingerprintjs/fingerprint-cli/commit/29e09ad4ebe50154f7ba1f7752d045061be845f0))
