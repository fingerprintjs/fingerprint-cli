---
"fingerprint": patch
---

A mistyped command no longer reports a `cli_run_started` event, which it used to file as a bare `fingerprint` run. It still reports `cli_command_run` with `command: unknown`, so the typo shows up in the error logs.
