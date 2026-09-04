---
"fingerprint": patch
---

pnpm no longer fails the run over blocked install scripts. On pnpm 10.5+ the CLI approves the build scripts of the packages it installs (`--allow-build`), so the install just succeeds; on older pnpm 10 the package is reported as installed with its optional scripts skipped, instead of as a failed integration.
