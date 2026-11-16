---
"fingerprint": minor
---

New `fingerprint analyze`: reads the workspace's recent identification events with the Server API key from the login bundle, prints what each page saw (events, bad bots, VPN, replayed ids, visitors) and suggests what to protect: a Rules Engine rule where bad bots cluster, single-use event ids where replays show up, a custom subdomain where confidence is low, and server-side verification when the repo never reads events back. `--days`, `--max`, `--path` and `--json`. Only aggregates are printed, never an event or visitor id. Staging (`FINGERPRINT_ENV=staging`) resolves the staging Server API; `FINGERPRINT_SERVER_API_URL` overrides it.
