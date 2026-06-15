# ShortsEngine Release Gate

This document describes the local release proof and the remote GitHub settings that should protect merges.

## Local Release Check

Run the full acceptance chain before a release candidate:

```bash
npm run lint
npm run env:check
npm run staging:check
npm run render:check
npm run render:manual
npm run render:proof
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

`npm run staging:check` verifies the staging deployment contract, GitHub Environment workflow shape, staging URL/provider rules, deployed-smoke defaults and secret-safe staging documentation.

`npm run render:check` verifies the live Render staging configuration contract without calling Render APIs. It confirms that provider `none` is no-network readiness-only, and that provider `render` has target `staging`, a `srv-...` service id, a protected deploy token and a public staging URL.

`npm run render:manual` prints the live setup checklist with placeholders only. `npm run render:proof` runs env/staging/render/deploy checks in provider `none` mode and confirms no deploy is triggered locally.

`npm run release:check` verifies the CI workflow contract, package scripts, environment readiness, staging readiness, report freshness, report safety, artifact upload policy and default cloud/browser safety settings.

`npm run release:evidence` writes `release/results/latest.json` plus a timestamped evidence report. The evidence report contains package metadata, checked commands, environment readiness, staging readiness, latest report status, artifact policy, branch-protection guidance and limitations. It must not contain secrets, absolute local paths, storage keys, provider raw errors or broad local state.

`npm run staging:smoke:full` is intentionally not part of the default release gate. Run it manually only with `SHORTSENGINE_STAGING_FULL_SMOKE=1` after health smoke is stable, because it uploads the fixture, creates a render job, waits for completion and downloads the resulting MP4.

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

## Staging Environment Gate

The staging workflow lives at `.github/workflows/staging.yml` and uses the GitHub Environment named `staging`.

It runs after `ShortsEngine CI` completes successfully or when manually dispatched. By default it is readiness-only: provider `none` passes the env/staging checks and records that no deploy occurred.

Render is the first provider-specific path. To enable it, configure the GitHub Environment `staging` with:

- `SHORTSENGINE_DEPLOY_TARGET=staging`
- `SHORTSENGINE_STAGING_DEPLOY_PROVIDER=render`
- `SHORTSENGINE_STAGING_SERVICE_ID=srv-...`
- `SHORTSENGINE_STAGING_URL=https://your-staging-host.example`
- secret `SHORTSENGINE_STAGING_DEPLOY_TOKEN`

Unsupported providers, missing service ids, missing tokens and unsafe staging URLs fail closed with safe structured errors.

The Render service should be a Node.js Web Service with build command `npm ci`, start command `npm start`, and health check path `/health`. Render should provide `PORT`; keep `MATCHCUTS_TRANSCRIPTION_PROVIDER=mock`, `MATCHCUTS_PERSISTENCE_ADAPTER=sqlite`, and `MATCHCUTS_STORAGE_ADAPTER=local` or `mock-cloud` for initial staging.

Run the staging workflow with manual dispatch first. Inspect the workflow status and the safe summaries from `env:check`, `staging:check`, `render:check`, `staging:deploy` and `staging:smoke`.

If GitHub reports a staging failure:

- `render:check` failure means the GitHub Environment is incomplete or unsafe.
- `staging:deploy` failure means Render rejected the deploy trigger or the service id/token is wrong.
- `staging:smoke` failure means the deployed `/health` endpoint is unreachable, invalid, unsafe or degraded beyond the smoke contract.

Use `docs/STAGING_DEPLOYMENT.md` to configure protected environment variables, protected credentials and deployed health smoke. Run deployed smoke manually with:

```bash
SHORTSENGINE_STAGING_URL=https://your-staging-host.example npm run staging:smoke
```

Run full upload/render smoke manually only when intended:

```bash
SHORTSENGINE_STAGING_FULL_SMOKE=1 SHORTSENGINE_STAGING_URL=https://your-staging-host.example npm run staging:smoke:full
```

For local proof, add `SHORTSENGINE_STAGING_ALLOW_LOCAL_URL=1` and point `SHORTSENGINE_STAGING_URL` at the local server.

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

Full staging upload/render smoke also remains opt-in and must not run in default CI. It is a manual proof step for staging environments with known storage and persistence behavior.
