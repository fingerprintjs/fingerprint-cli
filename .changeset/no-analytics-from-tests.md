---
"fingerprint": patch
---

The test suite no longer reports to production analytics. The `--ci` end-to-end test spawned the built CLI without redirecting the Management API, so every CI build posted a real anonymous `cli_run_started` and `cli_command_run` to the production project. `npm test` now sets `FINGERPRINT_DISABLE_ANALYTICS`, which `track()` honours, so a test cannot reach production even if it forgets to point the API somewhere harmless.
