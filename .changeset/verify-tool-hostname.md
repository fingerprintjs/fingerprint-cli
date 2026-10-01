---
"fingerprint": patch
---

Inside the wizard's subdomain step, the agent's `verify_subdomain` tool now only accepts the subdomain being set up, like `create_subdomain` already did. Another subdomain's id is looked up and refused before any verification is requested.
