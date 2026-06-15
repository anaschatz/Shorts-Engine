# Session: Staging Environment + Secrets Readiness

Date: 2026-06-15

Milestone:

- Added `.env.example` with safe defaults and empty secret placeholders.
- Added `docs/ENVIRONMENT.md` with the complete env contract and staging readiness checklist.
- Added `tools/release/check-environment.mjs`.
- Added `npm run env:check`.
- Wired env readiness into CI, `release:check` and `release:evidence`.
- Added environment tests and static lint guards.

Decisions:

- Keep mock transcription, local storage and local persistence as safe defaults.
- Reject browser E2E skip flags in staging readiness.
- Reject real provider/cloud modes unless credentials and required companion config are present.
- Do not print secret env var names or values in JSON readiness output.
- Keep real cloud integration opt-in.

Limitations:

- This prepares staging readiness but does not deploy to a cloud provider.
- Real provider/cloud credentials must be configured only in the deployment secret manager.
