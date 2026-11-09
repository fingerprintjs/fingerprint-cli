---
"fingerprint": patch
---

Failed runs report why they failed: each sign-in failure has its own error code (`login_timeout`, `login_denied`, `login_exchange_failed`, …), the reported message carries the underlying cause (the network error or HTTP status behind `login_unreachable`), and `install_failed` names the install that broke with the package manager's output.
