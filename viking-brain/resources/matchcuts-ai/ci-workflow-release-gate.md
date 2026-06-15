# CI Workflow + Automated Release Gate

ShortsEngine now has a GitHub Actions release gate that turns local checks into a merge/release safety contract.

## Workflow

- `.github/workflows/ci.yml`
- Runs on `pull_request`.
- Runs on pushes to `main` and `master`.
- Uses Node.js 20, which satisfies the Node 18+ project requirement.
- Installs dependencies with `npm ci` when `package-lock.json` exists, otherwise falls back to `npm install`.
- Caches npm through `actions/setup-node`.
- Caches Playwright Chromium under `~/.cache/ms-playwright`.
- Installs browser runtime with `npm run demo:browser:install`.

## Release Gate Commands

- `npm run lint`
- `npm run build`
- `npm test`
- `npm run eval`
- `npm run brain:health`
- `npm run demo:fixture`
- `npm run demo:smoke`
- `npm run demo:browser`
- `npm run demo:browser:ci`

## Failure Artifact Contract

- Uploads happen only when the workflow fails.
- Safe report allowlist:
  - `demo/results/latest.json`
  - `demo/results/browser-latest.json`
  - `demo/results/playwright-latest.json`
  - `demo/results/playwright-artifacts/`
  - `eval/results/latest.json`
- Passing runs do not upload reports, screenshots, traces or videos.
- The workflow does not upload `node_modules`, storage directories, uploads, renders, DB files, secrets, or raw local state.

## Safety Decisions

- Missing Playwright runtime fails by default in the release gate.
- `SHORTSENGINE_BROWSER_E2E_ALLOW_SKIP=1` must not be set in CI release-gate jobs.
- Real cloud integration is not part of the default CI gate and remains opt-in.
- Trace/video remain debugging-only env flags, not default CI behavior.
- Static lint validates the CI contract so future changes cannot silently weaken the gate.
