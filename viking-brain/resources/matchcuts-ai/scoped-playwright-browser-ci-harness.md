# Scoped Playwright Browser CI Harness

ShortsEngine now has a real browser E2E smoke runner for the full local demo path.

## Commands

- `npm run demo:browser:e2e` runs the Playwright Chromium browser flow.
- `npm run demo:browser:ci` aliases the same runner for CI-style checks.
- Reports are written to `demo/results/playwright-latest.json` and timestamped `playwright-smoke-*.json` files.

## Flow Covered

The Playwright harness starts a local server on a free port, waits for `/health`, opens Chromium headless and verifies:

- ShortsEngine page title and H1.
- Desktop and mobile no-horizontal-overflow checks.
- Initial fail-closed UI: export disabled, download hidden, cancel hidden, progress hidden.
- Safe missing-upload `UPLOAD_EMPTY` error.
- Fixture upload through the browser file input.
- Rights consent validation through the UI.
- Generate starts a job and exposes progress/cancel state.
- Render reaches completed `Rendered` status.
- Export/download controls become available only after completed render.
- Download endpoint returns `video/mp4` with non-zero bytes.

## Safety

- Browser reports use `demo/report-safety.mjs` before persistence.
- Reports do not include local absolute paths, storage keys, signed download tokens, provider raw errors or stack traces.
- Missing Playwright runtime fails with `PLAYWRIGHT_NOT_AVAILABLE`.
- Browser launch failures fail with `PLAYWRIGHT_LAUNCH_FAILED`.
- Explicit missing-runtime skip is available only with `SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP=1`.
- Server and browser contexts are closed in `finally` blocks.

## Implementation

- Runner: `demo/run-playwright-smoke.mjs`
- Tests: `tests/playwright-smoke.test.mjs`
- Package scripts: `demo:browser:e2e`, `demo:browser:ci`
- Dependency: `playwright` devDependency with Chromium runtime installed locally.

## Checks From Implementation

- `npm run lint`
- `npm run build`
- `npm test` passed 171 tests
- `npm run eval` passed with aggregate score 99
- `npm run brain:health`
- `npm run demo:fixture`
- `npm run demo:smoke`
- `npm run demo:browser`
- `npm run demo:browser:e2e`
- local `/health` returned `ready`

## Next

The next production milestone should focus on demo artifact hygiene and CI packaging: stable CI cache instructions for Playwright browsers, bounded retention of demo reports, and optional screenshot/video capture only on failure.
