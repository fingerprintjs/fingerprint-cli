---
"fingerprint": patch
---

A single `package.json` that holds both halves of the stack is now recognized as its own backend. Previously `integrate` only ever looked for a separate backend package, so a repo with react + express (or a Next.js app, which is its own server) resolved the frontend skill alone, never marked server-side verification as done, and asked for a backend repo path when the user picked that step. The server skill, the secret key and the verification step now all land in the app that's already there.
