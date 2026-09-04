---
"fingerprint": patch
---

The Get Started skill drives the integration run, one checklist step at a time. The agent completes one step (the first not done on the first run, then the one you pick), tells you how to verify it, and stops; only its final message is shown, with the working commentary kept in the debug log. The CLI then asks you to test the step and choose what's next: server-side verification (asking where the backend is if it lives in another repo), the custom subdomain, or the remaining steps. The feature skills the orchestrator dispatches to (proxy, rules, tagging, request filtering, smart signals) are installed alongside it so every step it names can be applied.
