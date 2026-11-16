---
"fingerprint": minor
---

New `fingerprint analyze`: reads the workspace's recent identification events with the Server API key from the login bundle, prints what each page saw (events, bad bots, VPN, replayed ids, visitors) and suggests what to protect: a Rules Engine rule where bad bots cluster, single-use event ids where replays show up, a custom subdomain where confidence is low, and server-side verification when the repo never reads events back. Then it asks which suggestion to apply: the integrate agent does that one step in the backend (asking where the backend lives when the repo has none), and the menu comes back until you stop. `--days`, `--max`, `--path` and `--json`; `--ci` prints the report only. Only aggregates are printed, never an event or visitor id. Staging (`FINGERPRINT_ENV=staging`) resolves the staging Server API; `FINGERPRINT_SERVER_API_URL` overrides it.
