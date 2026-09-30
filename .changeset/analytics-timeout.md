---
"fingerprint": patch
---

Analytics requests now wait up to 5 seconds instead of 1. The endpoint regularly took longer than a second from a cold process, so a good share of `cli_command_run` events were being dropped silently.
