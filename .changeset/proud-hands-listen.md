---
"fingerprint": minor
---

The integration run now ends with verification instead of stopping when the agent does: a reused secret key is probed against your workspace region, the code is checked for the env-var names that were provisioned, the app's own run command is printed, and — interactively — the CLI waits and confirms your first identification event actually reached Fingerprint, then names the remaining Get Started steps. A new `fingerprint verify` command re-runs the check standalone (exit 0 when an event arrived, 1 when not), for terminals that were closed early or for deployed apps.
