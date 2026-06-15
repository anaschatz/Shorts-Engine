# Remote CI Enforcement + Release Evidence Pack

ShortsEngine now has a local release verification layer that sits above the CI workflow and report validation gate.

## Commands

- `npm run release:check`
- `npm run release:evidence`

## Release Check Contract

`release:check` validates:

- GitHub Actions workflow exists and runs on pull requests plus main/master pushes.
- Required commands are present, including lint, build, tests, eval, brain health, demo smoke, browser smoke, Playwright browser CI, `ci:reports` and `release:check`.
- Playwright Chromium install is present.
- Missing browser runtime skip flag is not used in the release gate.
- Real cloud integration is not run by default.
- Failure artifacts upload only on `failure()`.
- Artifact upload allowlist is narrow.
- Latest demo/browser/Playwright/eval reports are fresh, passing and safe through `ci:reports`.

## Release Evidence

`release:evidence` writes `release/results/latest.json` and a timestamped report with:

- package metadata
- workflow contract summary
- commands checked
- latest report statuses
- artifact policy
- branch-protection guidance
- read-only remote detection summary
- limitations

Evidence must not include secrets, absolute paths, storage keys, raw provider errors or broad local state.

## Manual Remote Step

Branch protection remains a manual GitHub repository setting:

- require pull requests
- require the `Release gate` status check
- require up-to-date branches
- block force pushes
- block deletions
- require conversation resolution

The release tooling does not mutate remote settings.
