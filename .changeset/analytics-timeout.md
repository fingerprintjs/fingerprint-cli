---
"fingerprint": patch
---

Analytics requests get more time: 2 seconds for the events sent while a command runs and 5 seconds for `cli_command_run`, up from 1 second for all of them. The endpoint regularly took longer than a second from a cold process, so a good share of `cli_command_run` events were being dropped silently.
