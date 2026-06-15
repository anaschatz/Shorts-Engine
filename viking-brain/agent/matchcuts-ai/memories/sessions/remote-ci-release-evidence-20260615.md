# Session: Remote CI Enforcement + Release Evidence Pack

Date: 2026-06-15

Milestone:

- Added `tools/release/verify-release-gate.mjs`.
- Added `tools/release/write-release-evidence.mjs`.
- Added `npm run release:check` and `npm run release:evidence`.
- Added a Release gate self check step to GitHub Actions.
- Added release-gate tests and release documentation.

Decisions:

- Treat release evidence as generated proof after CI/demo/eval/browser reports are validated.
- Keep branch protection read-only/documented from local tooling; no remote mutations by default.
- Require failure-only artifact uploads with a narrow allowlist.
- Keep real cloud integration out of default CI.
- Keep browser missing-runtime skip out of release gates.

Focused checks to run:

- `npm run lint`
- `npm run build`
- `npm test`
- `npm run eval`
- `npm run brain:health`
- `npm run demo:fixture`
- `npm run demo:smoke`
- `npm run demo:browser`
- `npm run demo:browser:ci`
- `npm run ci:reports`
- `npm run release:check`
- `npm run release:evidence`

Limitations:

- Remote branch protection must still be enabled manually in GitHub.
- The local workspace may not have git remote metadata available.
