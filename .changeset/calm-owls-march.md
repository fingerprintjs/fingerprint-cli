---
"fingerprint": minor
---

The integration is now driven by the `fingerprint-get-started` orchestrator skill instead of a fixed hand-written target: the agent audits what's already done, applies only the Quick start steps that are missing (frontend identification, and server-side verification where a backend exists), and never invents a backend or a form the repo doesn't have. It closes by reporting the Get Started checklist, so the remaining steps are named rather than guessed at.
