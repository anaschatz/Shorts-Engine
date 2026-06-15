# Remote CI Verification Loop

ShortsEngine now has a local read-only remote CI verifier.

## Tool

- Script: `tools/release/check-remote-ci.mjs`
- Command: `npm run remote:ci`
- Backend: GitHub CLI (`gh`) with no hardcoded tokens.
- Workflow checked: `ShortsEngine CI`
- Job checked: `Release gate`

## Safety Contract

- Uses `execFile`, not shell command strings.
- Requires `gh auth status` but does not print raw auth output.
- Reads workflow run metadata only.
- Does not download raw logs or artifacts by default.
- Fails closed on invalid JSON, missing run, timeout, failed/cancelled CI, missing gh/auth, or sensitive output.
- Runs summaries through `demo/report-safety.mjs`.

## Bounded Config

- `SHORTSENGINE_REMOTE_CI_TIMEOUT_MS`
- `SHORTSENGINE_REMOTE_CI_POLL_INTERVAL_MS`
- Optional explicit refs:
  - `SHORTSENGINE_REMOTE_CI_BRANCH`
  - `SHORTSENGINE_REMOTE_CI_SHA`
  - `SHORTSENGINE_REMOTE_CI_WORKFLOW`
  - `SHORTSENGINE_REMOTE_CI_JOB`

## Fix-Forward Workflow

1. Run the local release chain.
2. Commit and push.
3. Run `npm run remote:ci`.
4. If remote CI fails, use only the safe failed-job summary.
5. Make a fix-forward change, rerun local validation, commit and push again.

## Tests

- `tests/remote-ci.test.mjs` mocks GitHub CLI output.
- Static lint verifies the script exists, is read-only, uses leak guards, and does not run staging deploy/full smoke or log/artifact download commands.
