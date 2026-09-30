---
"fingerprint": patch
---

`cli_command_run` now describes the wizard run: `wizard_steps` lists the choices in order, and when the run touched a custom subdomain it also carries `subdomain_outcome`, `subdomain_resumed` and `subdomain_dns`. `integrate_status` can be `waiting` for a run that ends with DNS records still pending. The Management API has to accept the new values before the CLI sends them.
