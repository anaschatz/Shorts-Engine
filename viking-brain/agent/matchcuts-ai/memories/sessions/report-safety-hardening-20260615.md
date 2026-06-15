# Session: Report Safety Hardening

Date: 2026-06-15

## Decisions

- Added `demo/report-safety.mjs` as the shared leak-detection boundary for persisted demo and browser reports.
- Kept demo/browser reports fail-closed: if unsafe metadata is found, write a minimal safe failure instead of the original report.
- Allowed signed download tokens only for direct API response validation, not for persisted reports.
- Added safe `leakCode` and `leakPath` metadata to help debugging without exposing the sensitive value.
- Left backend routing, worker and render orchestration unchanged because those boundaries were already clean and covered.

## Checks

- `npm run lint` passed.
- `npm run build` passed.
- `npm test` passed 167/167.
- `npm run eval` passed with aggregate score 99.
- `npm run brain:health` passed.
- `npm run demo:fixture` passed.
- `npm run demo:smoke` passed with 15 checks.
- `npm run demo:browser` passed.
- Local `/health` returned `ready`.

## Next

The next production milestone should be a scoped Playwright Browser CI Harness if repeatable true browser upload/generate/download automation is required.
