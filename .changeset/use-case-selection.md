---
"fingerprint": minor
---

`fingerprint integrate` in a repo that already has Fingerprint audits the code first, reports which Get Started steps are done (installed, server-side verification, custom subdomain) and asks "What's next?" with only the remaining steps; the remaining-steps option is offered as soon as server-side verification is done, so skipping the custom subdomain does not block it. Before the first step it asks whether to set Fingerprint up for a specific use case (account takeover, coupon abuse, ...) when the skills repo provides use-case skills, and hands the chosen ones to the agent for every step. Picking none, `--yes` and `--ci` run the basic integration.
