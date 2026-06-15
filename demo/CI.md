# ShortsEngine Browser E2E CI

Use this checklist for CI jobs that run the ShortsEngine release gate and Playwright browser demo.

The project CI workflow lives at `.github/workflows/ci.yml`.

## Setup

```bash
npm install
npm run demo:browser:install
npm run demo:fixture
```

`npm run demo:browser:install` installs the Playwright Chromium runtime. In CI, cache the Playwright browser cache directory supported by your runner so repeated jobs do not redownload Chromium. Keep the cache outside committed source files.

## Commands

```bash
npm run lint
npm run env:check
npm run staging:check
npm run build
npm test
npm run eval
npm run brain:health
npm run demo:fixture
npm run demo:smoke
npm run demo:browser
npm run demo:browser:ci
npm run ci:reports
npm run release:readiness
npm run release:check
```

`demo:browser:ci` runs the same real Chromium flow as `demo:browser:e2e`. `env:check` validates staging-safe environment defaults without requiring secrets. `staging:check` validates the provider-neutral staging workflow, GitHub Environment contract and deployed-smoke defaults without requiring a staging URL. `ci:reports` validates the latest demo, browser, Playwright and eval reports before the gate can pass. `release:readiness` is a no-network static check for release scripts, CI workflow markers and safe GitHub proof capability. `release:check` verifies the CI workflow contract, artifact allowlist, env readiness, staging readiness, release readiness and report gate as release evidence.

The GitHub Actions release gate uses `npm ci` when `package-lock.json` is present, installs Playwright Chromium with `npm run demo:browser:install`, then runs every command above. Real cloud integration stays out of the default gate and remains opt-in through its dedicated script/env flags. Full staging upload/render smoke also stays out of the default gate; `npm run staging:smoke:full` requires `SHORTSENGINE_STAGING_FULL_SMOKE=1` and is reserved for manual staging proof because it uploads a fixture, starts a render job and downloads the rendered MP4. Full smoke cleanup also stays out of the default gate; `npm run staging:smoke:cleanup` is dry-run by default and real deletion requires `SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP=1`.

For local release proof, run `npm run release:evidence` after the release gate passes. It writes `release/results/latest.json` with safe relative references, branch-protection guidance, release readiness and the latest report statuses.

Before post-push verification, check the local GitHub CLI setup:

```bash
npm run github:setup
gh auth status
npm run github:doctor
```

`npm run github:setup` is a no-network setup guide. It prints safe JSON with install options for macOS, Linux and Windows, manual `gh auth login` guidance, required read-only access, branch-protection `unknown` guidance and the next commands to run. It never starts auth, never asks for tokens, never downloads logs/artifacts and never mutates remote GitHub settings.

The doctor is read-only. It verifies `gh`, auth, `origin`, repository metadata, GitHub Actions metadata and branch protection readiness when permissions allow it. It does not mutate GitHub settings and does not download raw logs or artifacts.

## Runtime Behavior

- Passed runs exit `0`.
- Failed runs exit non-zero.
- Missing Playwright runtime fails with `PLAYWRIGHT_NOT_AVAILABLE` or `PLAYWRIGHT_LAUNCH_FAILED`.
- Missing-runtime skip is allowed only when explicit:

```bash
SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP=1 npm run demo:browser:ci
```

Do not use skip for release acceptance jobs.

## Artifacts

- Reports: `demo/results/playwright-latest.json`
- Timestamped reports: `demo/results/playwright-smoke-*.json`
- Failure-only artifacts: `demo/results/playwright-artifacts/`

Screenshots are captured only when the browser E2E fails. Passing runs should not create screenshots or videos.

Trace and video are opt-in and still failure-only:

```bash
SHORTSENGINE_BROWSER_E2E_TRACE=1 npm run demo:browser:ci
SHORTSENGINE_BROWSER_E2E_VIDEO=1 npm run demo:browser:ci
```

Reports include only relative artifact references and are checked by `demo/report-safety.mjs` before persistence.

Report safety treats provider identifiers and credentials as sensitive. Do not persist raw Render service ids, deploy tokens, API keys, GitHub tokens, storage keys, signed download tokens or local paths in demo, browser, CI, staging or release evidence reports.

`npm run ci:reports` is the release-gate proof step for reports. It fails closed when a required latest report is missing, stale, failed, contains sensitive data, contains unsafe relative references, or when a passing Playwright run includes browser artifact files.

After a push, verify the remote GitHub Actions result with:

```bash
npm run remote:ci
npm run remote:ci:proof
```

This command is intentionally outside the CI workflow. It uses `gh` in read-only mode, requires local `gh auth status`, polls the `ShortsEngine CI` workflow for the current commit, and reports whether the `Release gate` job passed. It does not download raw logs or artifacts by default. If it returns failure, use the safe failed-job summary for a fix-forward commit, then rerun local checks and push again.

`npm run remote:ci:proof` writes `release/results/remote-ci-latest.json` and a timestamped proof report. The proof keeps only safe metadata: repo owner/name, branch, commit, workflow run, release-job status, failed job names, bounded polling metadata and fix-forward guidance. Passing and failing proof reports both keep `logsDownloaded: false` and `artifactsDownloaded: false`.

The proof writer validates the remote CI summary before writing files. Malformed release-job metadata, invalid branch/SHA/run fields, unsafe URLs, local paths or secret-shaped values fail closed with safe structured errors.

Remote polling can be tuned without changing code:

```bash
SHORTSENGINE_REMOTE_CI_TIMEOUT_MS=300000 npm run remote:ci
SHORTSENGINE_REMOTE_CI_POLL_INTERVAL_MS=10000 npm run remote:ci
```

GitHub Actions uploads artifacts only when the release gate fails. The upload allowlist is intentionally narrow:

- `demo/results/latest.json`
- `demo/results/browser-latest.json`
- `demo/results/playwright-latest.json`
- `demo/results/playwright-artifacts/`
- `eval/results/latest.json`

The workflow must not upload `node_modules`, storage directories, uploads, renders, database files, secrets, raw local state, or broad result globs.

## Retention

The browser runner keeps retention bounded. Default retention is 20 managed Playwright reports/artifacts. You can override it with:

```bash
SHORTSENGINE_BROWSER_E2E_RETENTION_MAX=20 npm run demo:browser:ci
```

Cleanup only targets managed Playwright files under `demo/results/` and `demo/results/playwright-artifacts/`; fixtures and production data are not part of this cleanup.

## Reading Failures

Start with `demo/results/playwright-latest.json` for browser failures, `demo/results/latest.json` for API demo failures, and `eval/results/latest.json` for quality regressions. Each report uses safe relative paths and structured failure codes. Enable trace/video only for temporary debugging by setting `SHORTSENGINE_BROWSER_E2E_TRACE=1` or `SHORTSENGINE_BROWSER_E2E_VIDEO=1`; keep them off in the default release gate unless actively investigating a failure.

See `docs/RELEASE.md` for the branch protection checklist and release evidence contract.

For staging deployment wiring, see `docs/STAGING_DEPLOYMENT.md`. The staging workflow uses the GitHub Environment `staging`, runs `npm run staging:check`, and runs `npm run staging:smoke` only when `SHORTSENGINE_STAGING_URL` is configured.
