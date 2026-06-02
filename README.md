# Fingerprint CLI

CLI version of core Fingerprint dashboard onboarding workflows.

## Install

```bash
npm i -g fingerprint
```

## Quick start

```bash
fingerprint signup
fingerprint signup-confirm "<link from confirmation email>"
fingerprint workspace start
```

If signup is blocked in production due to visitor ID checks, the CLI opens dashboard signup and then you can run `fingerprint login`.

## Environment variables

- `FINGERPRINT_API_URL` (default: `https://mgmtapi.fpjs.sh`)
- `FINGERPRINT_REGION` (`us|eu|ap`, default: `us`)

## Commands

- `fingerprint signup|signup-confirm|login|logout|whoami`
- `fingerprint workspace ls|start|use`
