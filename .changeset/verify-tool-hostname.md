---
"fingerprint": patch
---

Inside the wizard's subdomain step, the agent's `verify_subdomain` tool now only accepts the subdomain being set up, like `create_subdomain` already did. Another subdomain's id is refused before anything is sent to the API.
