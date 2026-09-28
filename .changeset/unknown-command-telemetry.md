---
"fingerprint": patch
---

A mistyped command no longer reports a `cli_run_started` event, which it used to file as a bare `fingerprint` run. It still reports `cli_command_run` with `command: unknown`, and a signed-in run now includes what was typed, so the error logs show which command people tried.
