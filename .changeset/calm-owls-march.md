---
"fingerprint": minor
---

The integration is now driven by the `fingerprint-get-started` orchestrator skill instead of a fixed hand-written target: the agent audits what's already done, applies only the quick-start steps that are missing, and never invents a backend or a form the repo doesn't have. After the first identification event is confirmed, the CLI offers to finish the Quick start — detailed insights via the Server API, then ad-blocker protection guidance — while the optional "Beyond the basics" steps (rules, tagging, request filtering, team invites) are listed, not walked.
