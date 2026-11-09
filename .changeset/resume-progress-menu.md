---
"fingerprint": patch
---

`fingerprint` in a repo that already has Fingerprint no longer asks "Integrate Fingerprint into this repo?". It audits the code first, reports which Get Started steps are done (installed, server-side verification, custom subdomain) and asks "What's next?" with only the remaining steps. The remaining-steps option (rules, tagging, request filtering) is offered as soon as server-side verification is done, so skipping the custom subdomain no longer blocks it.
