---
"fingerprint": patch
---

`fingerprint integrate`, `keys` and `subdomains` sign you in through the browser when there's no session or it has expired, then carry on; JSON output and CI runs fail with the error instead. Before integrating, the CLI checks that the LLM gateway accepts the session token, so a token from another environment or one revoked server-side is caught before any keys are provisioned or files written. The bare `fingerprint` treats an expired session as signed out and goes straight to sign-in. Failed runs report why they failed: each sign-in failure has its own error code, the reported message carries the underlying cause, and `install_failed` names the install that broke with the package manager's output.
