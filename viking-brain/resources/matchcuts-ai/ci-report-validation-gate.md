# CI Report Validation Gate

ShortsEngine release acceptance includes a dedicated report-validation step after the demo, browser and eval checks.

## Command

- `npm run ci:reports`

## Required Latest Reports

- `demo/results/latest.json`
- `demo/results/browser-latest.json`
- `demo/results/playwright-latest.json`
- `eval/results/latest.json`

## Fail-Closed Rules

- Missing, empty, oversized or invalid JSON reports fail the gate.
- Stale reports fail the gate; default max age is two hours.
- Failed reports fail the gate.
- Reports are scanned with the shared sensitive-data leak guard.
- Relative report references must stay relative and must not contain traversal, absolute paths, drive paths or `file:` URLs.
- Playwright reports must keep trace/video disabled in the default release gate.
- A passing Playwright run must not list or leave managed browser failure artifacts.

## Artifact Contract

- Browser failure artifacts live only under `demo/results/playwright-artifacts/`.
- Passing release-gate runs should leave that directory empty or absent.
- GitHub Actions uploads the allowlisted reports/artifact directory only on failure.
- Do not upload storage directories, uploads, renders, database files, `node_modules`, secrets or broad result globs.

## Tests

- `tests/ci-reports.test.mjs` covers fresh reports, stale reports, sensitive contents, Playwright artifact references, stale artifact files and bounded max-age config.
- `tests/static-lint.mjs` protects the CI workflow and package script contract.
