# fingerprint

## 0.1.0-alpha.2

### Patch Changes

- A failed dependency install now fails the run (exit 1) instead of warning and reporting the integration as applied. pnpm's blocked-build-scripts failure gets a specific remediation (`pnpm approve-builds`), and declining an install in `--interactive` mode still exits cleanly — it's a choice, not a failure. ([36d3a87](https://github.com/fingerprintjs/fingerprint-cli/commit/36d3a8767c19fed080435f60da3b1423e65d7f0f))

## 0.1.0-alpha.1

### Patch Changes

- Report the installed CLI version consistently (banner, --version, and User-Agent header) by sourcing it from package.json at runtime. ([740db0b](https://github.com/fingerprintjs/fingerprint-cli/commit/740db0b3b6449109db0aea84d7e9377e2224de59))

## 0.1.0-alpha.0

### Minor Changes

- First release of the Fingerprint CLI, replacing the `0.0.2` placeholder package on npm. ([29e09ad](https://github.com/fingerprintjs/fingerprint-cli/commit/29e09ad4ebe50154f7ba1f7752d045061be845f0))
