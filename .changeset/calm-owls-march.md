---
"fingerprint": minor
---

The integration is now driven by the `fingerprint-get-started` orchestrator skill instead of a fixed hand-written target: the agent audits what's already done, applies only the Quick start steps that are missing (frontend identification, and server-side verification where a backend exists), and never invents a backend or a form the repo doesn't have. The run then ends with the next steps in the dashboard's order — run the app and check the first event, add the Server API step for detailed insights, protect against ad blockers — and only a completed run is offered the "set up another project?" question.
