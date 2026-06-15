# ShortsEngine Release Gate

This document describes the local release proof and the remote GitHub settings that should protect merges.

## Local Release Check

Run the full acceptance chain before a release candidate:

```bash
npm run lint
npm run env:check
npm run build
npm test
npm run eval
npm run brain:health
npm run demo:fixture
npm run demo:smoke
npm run demo:browser
npm run demo:browser:ci
npm run ci:reports
npm run release:check
npm run release:evidence
```

`npm run env:check` verifies staging-safe configuration defaults, numeric bounds, adapter/provider readiness and secret-safe environment documentation.

`npm run release:check` verifies the CI workflow contract, package scripts, environment readiness, report freshness, report safety, artifact upload policy and default cloud/browser safety settings.

`npm run release:evidence` writes `release/results/latest.json` plus a timestamped evidence report. The evidence report contains package metadata, checked commands, environment readiness, latest report status, artifact policy, branch-protection guidance and limitations. It must not contain secrets, absolute local paths, storage keys, provider raw errors or broad local state.

## Branch Protection Checklist

Enable these settings in GitHub manually:

- Require pull request before merge.
- Require the GitHub Actions job named `Release gate`.
- Require branches to be up to date before merge.
- Block force pushes.
- Block branch deletions.
- Require conversation resolution before merge.
- Keep signed commits or signed tags optional until the team explicitly adopts that policy.

The release tooling performs read-only local git remote detection when metadata exists. It does not mutate branch protection, repository settings, secrets or environments.

## Failure Artifacts

GitHub Actions uploads diagnostics only when the release gate fails:

- `demo/results/latest.json`
- `demo/results/browser-latest.json`
- `demo/results/playwright-latest.json`
- `demo/results/playwright-artifacts/`
- `eval/results/latest.json`

Passing runs should not upload reports or browser artifacts. Playwright trace/video capture stays opt-in for debugging and disabled in the default release gate.

## Opt-In Integrations

Real cloud integration remains opt-in and must not run in the default CI release gate. Use the dedicated integration command only with explicit credentials and environment flags.
