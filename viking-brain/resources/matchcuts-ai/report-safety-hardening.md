# Report Safety Hardening

ShortsEngine demo and browser smoke reports now share a single report-safety boundary.

## Boundary

- `demo/report-safety.mjs` owns recursive leak detection for persisted demo/browser reports.
- `demo/run-smoke.mjs` and `demo/run-browser-smoke.mjs` use the same guard before writing public reports.
- Signed download tokens are treated as sensitive in persisted reports.
- The API smoke may allow a signed token only when checking the download URL response itself; the token is not copied into the report.

## Guarded Data

The report guard fails closed on:

- absolute local paths
- `file://` and Windows-style local paths
- storage keys and raw path fields
- stdout/stderr/stack/raw provider output fields
- OpenAI/API key style secrets
- bearer tokens, AWS keys and S3 signatures
- ShortsEngine signed download tokens

When a leak is detected, reports are replaced with a minimal structured failure containing only safe `leakCode` and `leakPath` metadata.

## Tests

- `tests/demo-smoke.test.mjs` covers unsafe keys, paths, provider secret text and signed token handling.
- `tests/browser-demo.test.mjs` verifies browser reports fail closed with safe leak metadata.
- `tests/static-lint.mjs` keeps the report-safety boundary present in future changes.

## Checks From Implementation

- `npm run lint`
- `npm run build`
- `npm test` passed 167 tests
- `npm run eval` passed with aggregate score 99
- `npm run brain:health`
- `npm run demo:fixture`
- `npm run demo:smoke`
- `npm run demo:browser`
- local `/health` returned `ready`

## Limitation

This pass hardens report and demo observability boundaries. It does not add full browser automation; the current browser smoke remains dependency-light plus API E2E fallback.
