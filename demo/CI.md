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
npm run youtube:doctor
npm run ocr:doctor
npm run build
npm test
npm run eval
npm run eval:reference
npm run brain:health
npm run demo:fixture
npm run ocr:smoke
npm run ocr:qa:review
npm run demo:smoke
npm run demo:browser
npm run demo:browser:ci
npm run ci:reports
npm run release:readiness
npm run release:check
npm run branch:setup
npm run branch:doctor
npm run branch:proof
```

`demo:browser:ci` runs the same real Chromium flow as `demo:browser:e2e`. `env:check` validates staging-safe environment defaults without requiring secrets. `staging:check` validates the provider-neutral staging workflow, GitHub Environment contract and deployed-smoke defaults without requiring a staging URL. `youtube:doctor` validates the default-disabled YouTube ingest runtime without network or downloader calls. `ocr:doctor` validates scoreboard OCR readiness without installing Tesseract, starting auth or requiring OCR by default. `ocr:smoke` writes `demo/results/ocr-latest.json` and proves the sampled-frame/OCR fallback contract; local OCR remains opt-in and missing Tesseract fails only when explicitly enabled. Optional OCR crop thumbnails require `SHORTSENGINE_OCR_QA_ARTIFACTS=1` and stay under `demo/results/ocr-artifacts/<run-id>/` with a bounded `ocr-qa-manifest.json` and safe relative refs only. Live scoreboard OCR proof can additionally set `SHORTSENGINE_SCOREBOARD_OCR_QA_ARTIFACTS=1` to write `demo/results/ocr-scoreboard-qa-latest.json` plus `demo/results/scoreboard-ocr-artifacts/<run-id>/contact-sheet.json` and `review.html` with sanitized OCR attempt rows, focused scorebug digit-reader status and crop refs. `ocr:qa:review` writes `demo/results/ocr-qa-review-latest.json`; in CI/default mode it skips safely without manual input, while operator-provided review JSON produces support-only OCR calibration scores. `eval:reference` validates the reference-style football editing quality loop without network or API keys. `ci:reports` validates the latest demo, OCR, browser, Playwright, eval and reference review reports before the gate can pass. `release:readiness` is a no-network static check for release scripts, CI workflow markers and safe GitHub proof capability. `release:check` verifies the CI workflow contract, artifact allowlist, env readiness, staging readiness, release readiness and report gate as release evidence.

The GitHub Actions release gate uses `npm ci` when `package-lock.json` is present, installs Playwright Chromium with `npm run demo:browser:install`, installs the Ubuntu `ffmpeg` package, verifies `ffmpeg` and `ffprobe`, then runs every command above. The release gate and demo smoke runners keep the default local persistence adapter so the suite can verify safe defaults on Node 20; sqlite remains covered by focused adapter tests and staging configuration. Real cloud integration stays out of the default gate and remains opt-in through its dedicated script/env flags. Full staging upload/render smoke also stays out of the default gate; `npm run staging:smoke:full` requires `SHORTSENGINE_STAGING_FULL_SMOKE=1` and is reserved for manual staging proof because it uploads a fixture, starts a render job and downloads the rendered MP4. Full smoke cleanup also stays out of the default gate; `npm run staging:smoke:cleanup` is dry-run by default and real deletion requires `SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP=1`. YouTube smoke stays out of the default gate; `npm run youtube:smoke` requires `SHORTSENGINE_YOUTUBE_SMOKE=1`, enabled ingest, a downloader and an authorized allowlisted/manual URL.

For the first real downloader proof, follow `docs/YOUTUBE_INGEST_MANUAL_SMOKE.md`. It keeps downloader install, legal/rights review, smoke flags, report reading and cleanup as manual operator actions outside the release gate. The explicit local command is `npm run youtube:proof:operator`; without the live opt-in flags it must write a skipped report and start no server or downloader work.

For local release proof, run `npm run release:evidence` after the release gate passes. It writes `release/results/latest.json` with safe relative references, branch-protection guidance, release readiness and the latest report statuses.

For branch policy proof, run:

```bash
npm run branch:setup
npm run branch:doctor
npm run branch:proof
```

`branch:setup` is documentation-only. It prints the manual GitHub UI path `Settings -> Rules -> Rulesets`, the required active branch ruleset for `main`, the required status check `Release gate`, and the post-setup proof commands. It does not call GitHub APIs, request tokens, start auth, mutate rulesets, or download logs/artifacts.

`branch:doctor` and `branch:proof` are read-only. They check GitHub CLI readiness, the exact local commit and remote `main` SHA, classic branch protection when visible, repository rulesets when visible, and the expected `Release gate` policy. They never mutate GitHub settings and never download logs or artifacts. If GitHub returns `incomplete`, configure the missing ruleset in the GitHub UI. If GitHub returns `unknown` because branch protection or rulesets are not readable, confirm the checklist in `docs/RELEASE.md` manually in the GitHub UI.

Before post-push verification, check the local GitHub CLI setup:

```bash
npm run github:setup
gh auth status
npm run github:doctor
```

`npm run github:setup` is a no-network setup guide. It prints safe JSON with install options for macOS, Linux and Windows, official GitHub CLI install links, manual `gh auth login` guidance, required read-only access, expected repository `anaschatz/Shorts-Engine`, expected workflow/job names, branch-protection `unknown` guidance and the next commands to run. It never starts auth, never asks for tokens, never downloads logs/artifacts and never mutates remote GitHub settings.

The doctor is read-only. It verifies `gh`, auth, `origin`, repository metadata, GitHub Actions metadata and branch protection readiness when permissions allow it. Its safe failures include `phase`, `status`, `passed: false`, `skipped: false` and `nextAction` for missing CLI, missing auth, network unavailable, unreadable repository, unreadable Actions metadata, unreadable branch protection and unsafe output. It does not mutate GitHub settings and does not download raw logs or artifacts.

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

Report safety treats provider identifiers and credentials as sensitive. Do not persist raw Render service ids, deploy tokens, API keys, GitHub/GitLab/Slack tokens, private-key blocks, YouTube cookies, storage keys, signed download tokens or local paths in demo, browser, CI, staging or release evidence reports.

`npm run ci:reports` is the release-gate proof step for reports. It fails closed when a required latest report is missing, stale, failed, contains sensitive data, contains unsafe relative references, or when a passing Playwright run includes browser artifact files.

After a push, verify the remote GitHub Actions result with:

```bash
npm run remote:ci
npm run remote:ci:proof
```

This command is intentionally outside the CI workflow. It uses `gh` in read-only mode, requires local `gh auth status`, polls the `ShortsEngine CI` workflow for the current commit, verifies the exact `headSha`, and reports whether the `Release gate` job passed. It does not download raw logs or artifacts by default. If it returns failure, use the safe failed-job summary for a fix-forward commit, then rerun local checks and push again.

`npm run remote:ci:proof` writes `release/results/remote-ci-latest.json` and a timestamped proof report. The proof keeps only safe metadata: repo owner/name, branch, commit, workflow run, release-job status, failed job names, bounded polling metadata, `phase`, `status`, `passed`, `skipped`, `nextAction`, triage summary and fix-forward guidance. Passing and failing proof reports both keep `logsDownloaded: false` and `artifactsDownloaded: false`.

If `gh` is missing or unauthenticated, proof generation returns `GITHUB_CLI_MISSING` or `GITHUB_AUTH_MISSING` and still writes a safe failure proof. Those failures include `operatorRecovery` commands such as `npm run github:setup`, `brew install gh`, `gh --version`, `gh auth login` and `gh auth status`; they are instructions only and are never executed automatically. If GitHub/network access is unavailable, the doctor returns `GITHUB_NETWORK_UNAVAILABLE` and remote proof returns `REMOTE_CI_NETWORK_UNAVAILABLE`. If no exact commit run is found, the run times out, or the run SHA does not match, it returns `REMOTE_CI_RUN_NOT_FOUND`, `REMOTE_CI_TIMEOUT` or `REMOTE_CI_SHA_MISMATCH`. Failed, cancelled and pending runs get distinct safe `status` values. These reports never include raw stderr, tokens, logs or downloaded artifacts.

The proof writer validates the remote CI summary before writing files. Malformed release-job metadata, invalid branch/SHA/run fields, unsafe URLs, local paths or secret-shaped values fail closed with safe structured errors.

Remote polling can be tuned without changing code:

```bash
SHORTSENGINE_REMOTE_CI_TIMEOUT_MS=300000 npm run remote:ci
SHORTSENGINE_REMOTE_CI_POLL_INTERVAL_MS=10000 npm run remote:ci
```

GitHub Actions uploads artifacts only when the release gate fails. The upload allowlist is intentionally narrow:

- `demo/results/latest.json`
- `demo/results/ocr-latest.json`
- `demo/results/ocr-qa-review-latest.json`
- `demo/results/browser-latest.json`
- `demo/results/playwright-latest.json`
- `demo/results/playwright-artifacts/`
- `eval/results/latest.json`
- `eval/results/reference-latest.json`

The workflow must not upload `node_modules`, storage directories, uploads, renders, database files, secrets, raw local state, OCR crop artifact directories, or broad result globs.

For local OCR crop QA, run:

```bash
SHORTSENGINE_SCOREBOARD_OCR_ENABLED=1 SHORTSENGINE_SCOREBOARD_OCR_PROVIDER=local npm run ocr:doctor
SHORTSENGINE_SCOREBOARD_OCR_ENABLED=1 SHORTSENGINE_SCOREBOARD_OCR_PROVIDER=local SHORTSENGINE_OCR_QA_ARTIFACTS=1 npm run ocr:smoke
SHORTSENGINE_OCR_QA_REVIEW_INPUT=demo/results/ocr-qa-review-input.json npm run ocr:qa:review
```

If Tesseract is missing, the smoke fails with `OCR_RUNTIME_MISSING` and safe `nextAction` guidance. The report still avoids raw command output. OCR QA artifacts are local debug-only, manifest-validated and should not be uploaded in passing CI runs.

The OCR QA review input must reference the generated `ocr-qa-manifest.json` with a safe relative ref and contain only bounded crop ids, boolean visibility/readability/usefulness fields and short safe notes. Reports never include raw OCR text, full frames, local crop paths, stdout/stderr, provider output, tokens or secrets. Calibration remains `support_only`, so readable OCR can support goal/offside evidence only next to visual football action evidence.

The local browser UI mirrors that contract in the Quality review panel. It loads `GET /api/ocr-qa/latest`, previews thumbnails only through `GET /api/ocr-qa/crop`, and submits reviews through `POST /api/ocr-qa/review`. Missing manifests keep the submit action disabled. The UI is operator-assisted, stays out of the default CI gate, and must never display raw OCR text or use OCR-only evidence to confirm a goal.

## Retention

The browser runner keeps retention bounded. Default retention is 20 managed Playwright reports/artifacts. You can override it with:

```bash
SHORTSENGINE_BROWSER_E2E_RETENTION_MAX=20 npm run demo:browser:ci
```

Cleanup only targets managed Playwright files under `demo/results/` and `demo/results/playwright-artifacts/`; fixtures and production data are not part of this cleanup.

## Reading Failures

Start with `demo/results/playwright-latest.json` for browser failures, `demo/results/latest.json` for API demo failures, `demo/results/ocr-latest.json` for OCR readiness/smoke failures, and `eval/results/latest.json` for quality regressions. Each report uses safe relative paths and structured failure codes. Enable trace/video only for temporary debugging by setting `SHORTSENGINE_BROWSER_E2E_TRACE=1` or `SHORTSENGINE_BROWSER_E2E_VIDEO=1`; keep them off in the default release gate unless actively investigating a failure.

See `docs/RELEASE.md` for the branch protection checklist and release evidence contract.

For staging deployment wiring, see `docs/STAGING_DEPLOYMENT.md`. The staging workflow uses the GitHub Environment `staging`, runs `npm run staging:check`, and runs `npm run staging:smoke` only when `SHORTSENGINE_STAGING_URL` is configured.
