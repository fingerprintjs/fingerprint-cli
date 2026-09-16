---
"fingerprint": patch
---

A run that stops because nobody is signed in now reports `status: unauthenticated` on `cli_command_run` instead of `error`. Sign-in-required exits, the CI run with no credentials, and a browser login nobody came back to were all landing in the same bucket as genuine failures, which inflated the error rate of every command that needs a session. The Management API has to accept the new value before the CLI sends it.
