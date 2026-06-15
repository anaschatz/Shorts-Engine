# CI Packaging + Failure-Only Browser Artifacts

ShortsEngine browser E2E now has CI packaging guidance and bounded artifact behavior.

## Commands

- `npm run demo:browser:install` installs the Playwright Chromium runtime.
- `npm run demo:browser:e2e` runs the real Chromium browser flow.
- `npm run demo:browser:ci` aliases the same runner for pipeline usage.

## Artifact Contract

- `demo/results/playwright-latest.json` is the stable latest report.
- `demo/results/playwright-smoke-*.json` are timestamped reports.
- `demo/results/playwright-artifacts/` is reserved for managed browser artifacts.
- Screenshots are failure-only by default.
- Trace capture requires `SHORTSENGINE_BROWSER_E2E_TRACE=1`.
- Video capture requires `SHORTSENGINE_BROWSER_E2E_VIDEO=1`.
- Passing runs should not create screenshots or videos.
- Report artifact references must stay relative and under `demo/results/playwright-artifacts/`.

## Safety Rules

- Missing Playwright/runtime fails by default.
- Runtime skip is allowed only with `SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP=1`.
- Runner timeouts and retention are bounded.
- Retention cleanup targets only managed Playwright reports/artifacts.
- Reports pass through the shared leak guard before persistence.
- Do not store local absolute paths, storage keys, secrets, raw browser output or provider errors in reports.

## Current Checks

- Static lint asserts docs, scripts, artifact flags and cleanup hooks.
- Unit tests cover report shape, missing-runtime behavior, safe artifact refs, trace/video opt-in and retention cleanup.
- Browser acceptance commands have passed locally with empty artifact files on passing runs.
