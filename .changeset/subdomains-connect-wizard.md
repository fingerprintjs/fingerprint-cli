---
"fingerprint": patch
---

In the wizard's custom subdomain step, when the DNS provider supports Domain Connect the CLI offers to open the provider and let it add the DNS records, then waits for validation. The run reports it on `cli_command_run` as `subdomain_dns: domain_connect` with `subdomain_provider`.
