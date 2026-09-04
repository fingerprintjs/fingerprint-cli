---
"fingerprint": minor
---

The integration is now driven by the `fingerprint-get-started` orchestrator skill instead of a fixed hand-written target: the agent audits what's already done, applies only the Quick start steps that are missing (frontend identification, and server-side verification where a backend exists), and never invents a backend or a form the repo doesn't have. The run then ends with how to verify — the repo's own dev command and a link to your Get Started page in the dashboard, which marks step 1 complete when the first event arrives — and nothing else: no checklist of its own, no claims about which step is done, and no "set up the other side / another project?" prompt.
