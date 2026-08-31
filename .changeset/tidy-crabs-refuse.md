---
"fingerprint": patch
---

A failed dependency install now fails the run (exit 1) instead of warning and reporting the integration as applied. pnpm's blocked-build-scripts failure gets a specific remediation (`pnpm approve-builds`), and declining an install in `--interactive` mode still exits cleanly — it's a choice, not a failure.
