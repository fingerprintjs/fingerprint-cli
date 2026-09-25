---
"fingerprint": patch
---

Keep offering server-side verification in the next-step menu after the first integration step. The wizard treated the installed server SDK as proof that the Server API was already wired up, so step 2 was filtered out before the user ever saw it. The check looks for Server API calls and for real import statements, not for a bare mention of the package name.
