---
'fingerprint': patch
---

Report runs that never sign in, so the onboarding funnel has a denominator. A run with no key
relays through the Management API's unauthenticated analytics route instead of reporting nothing,
and `DO_NOT_TRACK` now silences the CLI.
