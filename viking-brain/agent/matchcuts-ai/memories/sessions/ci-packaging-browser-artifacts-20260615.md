# Session: CI Packaging + Failure-Only Browser Artifacts

Date: 2026-06-15

## Decisions

- Added CI documentation for Playwright browser E2E setup, runtime install, skip semantics and retention.
- Kept `demo:browser:e2e` as the real Chromium flow and added/kept `demo:browser:ci` as the pipeline-facing alias.
- Added `demo:browser:install` for explicit Chromium runtime setup.
- Added failure-only screenshot capture with safe relative artifact refs.
- Kept trace and video disabled unless explicitly enabled by `SHORTSENGINE_BROWSER_E2E_TRACE=1` or `SHORTSENGINE_BROWSER_E2E_VIDEO=1`.
- Added bounded retention cleanup for managed Playwright reports and browser artifacts only.
- Passing Playwright runs now report `artifacts.files: []`; artifact files are not created on the default passing path.

## Checks

- `npm run lint` passed.
- `npm run build` passed.
- `npm test` passed 174/174.
- `npm run eval` passed with aggregate score 99.
- `npm run demo:fixture` passed.
- `npm run demo:smoke` passed with 15 checks.
- `npm run demo:browser` passed.
- `npm run demo:browser:e2e` passed.
- `npm run demo:browser:ci` passed.

## Reports

- `demo/results/playwright-latest.json`
- `demo/results/playwright-smoke-2026-06-15T17-23-27-345Z.json`

## Next

Add a full CI workflow file once the target provider is chosen, including cache paths for Playwright Chromium and uploaded failure-only artifacts.
