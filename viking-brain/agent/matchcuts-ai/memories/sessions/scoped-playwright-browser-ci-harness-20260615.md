# Session: Scoped Playwright Browser CI Harness

Date: 2026-06-15

## Decisions

- Installed `playwright` as a scoped devDependency and installed the Chromium runtime.
- Added `demo/run-playwright-smoke.mjs` for real browser upload/generate/render/download automation.
- Kept `npm run demo:browser` dependency-light and added `npm run demo:browser:e2e` / `npm run demo:browser:ci` for Playwright.
- Kept Playwright outside `npm test` to avoid making the base suite flaky; added unit/static coverage for runner report shape, leak guard and missing-runtime behavior.
- Persisted Playwright reports through the shared report-safety guard.

## Checks

- `npm run lint` passed.
- `npm run build` passed.
- `npm test` passed 171/171.
- `npm run eval` passed with aggregate score 99.
- `npm run brain:health` passed.
- `npm run demo:fixture` passed.
- `npm run demo:smoke` passed with 15 checks.
- `npm run demo:browser` passed.
- `npm run demo:browser:e2e` passed.
- Local `/health` returned `ready`.

## Reports

- `demo/results/playwright-latest.json`
- Latest Playwright run passed and verified desktop/mobile overflow, UI gates, browser fixture upload, rights validation, job progress, completed render and video download.

## Next

Add CI packaging guidance for Playwright browser cache and optional failure-only screenshots/videos.
