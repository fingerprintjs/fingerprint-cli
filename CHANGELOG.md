# fingerprint

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
