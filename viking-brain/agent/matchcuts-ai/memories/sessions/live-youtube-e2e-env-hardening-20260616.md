# Session Memory: Live YouTube E2E Env Hardening

Date: 2026-06-16

Decisions:

- Added live YouTube E2E flags to the central environment contract.
- Kept live proof and browser proof disabled by default.
- Required explicit ingest enablement, rights confirmation, safe YouTube URL and allowlist/manual unlisted gate before live proof can pass readiness.
- Kept readiness summaries path-safe and URL-safe by exposing only booleans and bounded numeric settings.

Validation target:

- `npm run env:check`
- `npm test`
- `npm run youtube:doctor`
- `npm run youtube:smoke`
- `npm run youtube:e2e:local`

Known limitation:

- Real downloader/browser live proof remains manual and depends on operator rights, downloader install and a local environment that allows server binding.
