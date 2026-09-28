---
"fingerprint": patch
---

`integrate` now recognizes browser code with no framework SDK and applies the `fingerprint-javascript` skill, instead of reporting that no integration is available. This covers a bundled app with no framework dependency (detected from its `index.html` entry), Solid, Lit, Alpine, htmx and jQuery, a static site with no `package.json` at all, and a Node server's plain `public/index.html` (detected as a static frontend alongside the backend) — where the public key and region are handed to the integration directly, since there is no env file to read them from and no manifest to install into.
