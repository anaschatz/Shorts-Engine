# ShortsEngine Local Demo

This folder contains the repeatable local demo harness for the video-to-short flow.

## Commands

- `npm run demo:fixture` creates `demo/fixtures/shortsengine-demo-source.mp4` with FFmpeg.
- `npm run demo:smoke` starts a local server, uploads the fixture, runs generate/render, polls the job, downloads the completed export, and writes `demo/results/latest.json`.
- `npm run demo:e2e` currently aliases the smoke harness and is the command to use for acceptance checks.
- `npm run demo:browser` runs dependency-light browser-facing contract checks plus the API demo smoke, then writes `demo/results/browser-latest.json`.
- `npm run demo:browser:e2e` runs the real Playwright Chromium browser flow and writes `demo/results/playwright-latest.json`.
- `npm run demo:browser:install` installs the Playwright Chromium runtime for local/CI browser E2E.
- `npm run demo:compare` compares a generated short and a reference short with structural metrics plus optional operator scoring.
- `npm run demo:human-review` turns a successful live YouTube proof or direct generated/reference refs into `demo/results/human-visual-review-latest.json`.
- `npm run env:check` validates staging-safe environment defaults, docs, `.env.example`, and secret-safe readiness output.
- `npm run staging:check` validates provider-neutral staging wiring, GitHub Environment expectations, and deployed-smoke defaults.
- `npm run ci:reports` validates the latest API demo, browser, Playwright and eval reports before a release gate can pass.
- `npm run release:check` verifies the CI workflow, package scripts, report safety and artifact policy.
- `npm run release:evidence` writes the safe release evidence JSON under `release/results/`.
- `npm run demo:manual` prints the manual browser testing checklist.

The demo uses mock transcription by default and does not require API keys. It requires FFmpeg/FFprobe for the full render path; if FFmpeg is unavailable, the smoke report fails with a safe error code instead of leaking local paths or raw process output.

The Playwright E2E command requires the `playwright` dev dependency and a local Chromium runtime. If the runtime is unavailable, the report fails with `PLAYWRIGHT_NOT_AVAILABLE` or `PLAYWRIGHT_LAUNCH_FAILED` instead of leaking local paths or browser process output. You can explicitly skip missing-runtime browser E2E in constrained CI with `SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP=1 npm run demo:browser:e2e`.

Failure-only browser artifacts live under `demo/results/playwright-artifacts/`. Screenshots are captured only on failed runs. Trace/video capture requires `SHORTSENGINE_BROWSER_E2E_TRACE=1` or `SHORTSENGINE_BROWSER_E2E_VIDEO=1` and remains failure-only. See `demo/CI.md` for CI setup and retention guidance.

`npm run ci:reports` fails closed when a required latest report is missing, stale, failed, contains sensitive data, contains unsafe relative references, or when a passing Playwright run leaves managed browser failure artifacts behind.

For manual user-path QA, follow `demo/MANUAL_TESTING.md` after the automated smoke checks pass.

For live YouTube product review, run `npm run youtube:proof:operator` only after
rights confirmation and downloader readiness, then run `npm run
demo:human-review -- --reference=<safe-relative-reference-mp4>`. Without a human
review JSON the result remains `pending_human_review`, which keeps machine
metadata separate from creative judgement.
