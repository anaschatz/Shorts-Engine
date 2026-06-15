# Session: CI Workflow + Automated Release Gate

Date: 2026-06-15

## Decisions

- Added `.github/workflows/ci.yml` as the GitHub Actions release gate.
- The workflow runs local quality, eval, OpenViking health, API demo smoke, browser contract smoke and Playwright browser CI.
- The workflow installs Playwright Chromium through the project script and fails if the runtime is missing.
- Failure artifacts are uploaded only on job failure and only from a narrow allowlist of safe reports/browser artifacts.
- Real cloud integration remains opt-in and is not run by the default release gate.
- Static lint now validates the workflow commands, failure-only upload behavior, no skip flag, no unsafe uploads and no real cloud integration.

## Checks

- `npm run lint` passed.
- `npm run build` passed.
- `npm test` passed 174/174.
- `npm run eval` passed with aggregate score 99.
- `npm run brain:health` passed.
- `npm run demo:fixture` passed.
- `npm run demo:smoke` passed with 15 checks.
- `npm run demo:browser` passed.
- `npm run demo:browser:ci` passed.
- Local `/health` returned `ready`.

## Limitations

- The workflow has not been executed by GitHub Actions inside this local environment.
- Provider-specific CI tuning, branch protection and artifact retention policy enforcement must be configured in the remote repository settings.
