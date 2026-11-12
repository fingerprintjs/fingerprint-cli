---
"fingerprint": patch
---

`fingerprint integrate` signs you in through the browser when there's no session or it has expired, then carries on; `keys`, `subdomains` and `whoami` do the same when there's no session at all. JSON output and CI runs fail with the error instead. Before integrating, the CLI checks that the LLM gateway accepts the session token, so a token from another environment or one revoked server-side is caught before any keys are provisioned or files written; a gateway that can't check it fails the run rather than letting it proceed unverified. The bare `fingerprint` treats an expired session as signed out and goes straight to sign-in. Failed runs report why they failed: each sign-in failure has its own error code, the reported message carries the underlying cause, and `install_failed` names the install that broke with the package manager's output.
