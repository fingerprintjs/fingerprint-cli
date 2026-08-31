---
"fingerprint": minor
---

The integration is now driven by the `fingerprint-get-started` orchestrator skill instead of a fixed hand-written target: the agent audits what's already done, applies only the quick-start steps that are missing, and never invents a backend or a form the repo doesn't have. After the first identification event is confirmed, the CLI offers to continue the remaining Get Started steps (rules, tagging, request filtering) — dashboard-only parts come as exact instructions, the ad-blocker/proxy step stays guidance.
