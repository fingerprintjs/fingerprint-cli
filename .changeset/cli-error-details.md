---
"fingerprint": patch
---

A failed run now reports why. `cli_command_run` carries `error_code`, a short identifier for the kind of failure (skills fetch, install, agent, missing session, unknown command), plus the error message. Previously a failure reported `status: error` and nothing else.
