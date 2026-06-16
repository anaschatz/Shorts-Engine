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
npm run release:readiness
npm run release:check
npm run release:evidence
```

`npm run env:check` verifies staging-safe configuration defaults, numeric bounds, adapter/provider readiness and secret-safe environment documentation.

`npm run staging:check` verifies the staging deployment contract, GitHub Environment workflow shape, staging URL/provider rules, deployed-smoke defaults and secret-safe staging documentation.

`npm run render:check` verifies the live Render staging configuration contract without calling Render APIs. It confirms that provider `none` is no-network readiness-only, and that provider `render` has target `staging`, a `srv-...` service id, a protected deploy token and a public staging URL.

`npm run render:manual` prints the live setup checklist with placeholders only. `npm run render:proof` runs env/staging/render/deploy checks in provider `none` mode and confirms no deploy is triggered locally.

`npm run release:check` verifies the CI workflow contract, package scripts, environment readiness, staging readiness, report freshness, report safety, artifact upload policy and default cloud/browser safety settings.

`npm run release:readiness` performs a no-network static readiness check for release/CI proof capabilities. It verifies the required release scripts and CI workflow markers, reports safe GitHub proof commands, and declares `networkCalls: false`, `authStarted: false`, `remoteMutation: false`, `logsDownloaded: false` and `artifactsDownloaded: false`.

`npm run release:evidence` writes `release/results/latest.json` plus a timestamped evidence report. The evidence report contains package metadata, checked commands, environment readiness, staging readiness, release readiness, latest report status, artifact policy, branch-protection guidance and limitations. It must not contain secrets, absolute local paths, storage keys, provider raw errors or broad local state.

Release evidence must also avoid raw provider identifiers. Render service ids, deploy tokens, API keys, signed download tokens, GitHub/GitLab/Slack tokens, private-key blocks and YouTube cookies are treated as sensitive; reports should expose only configured/not-configured booleans and safe provider status metadata.

Before relying on remote GitHub evidence, check the local GitHub CLI setup:

```bash
npm run github:setup
gh auth status
npm run github:doctor
```

`npm run github:setup` prints a documentation-only setup guide. It does not install `gh`, does not run `gh auth login`, does not request tokens, does not call GitHub APIs, and does not mutate repository settings. Use it when `github:doctor`, `remote:ci` or `remote:ci:proof` fail with missing CLI/auth errors. It documents macOS, Linux and Windows install options, official GitHub CLI install links, manual auth steps, high-level read-only permissions, expected repository `anaschatz/Shorts-Engine`, expected workflow/job names, branch-protection `unknown` guidance and the post-push verification commands.

`github:doctor` is read-only. It verifies that `gh` is installed, authenticated, pointed at a readable `origin` repository, able to read GitHub Actions metadata, and able to inspect branch protection when permissions allow it. Branch protection may return `unknown` when GitHub permissions or rulesets hide the settings; in that case, use the GitHub UI checklist below. The doctor returns safe `phase`, `status`, `passed`, `skipped` and `nextAction` fields for failures such as `GITHUB_CLI_MISSING`, `GITHUB_AUTH_MISSING`, `GITHUB_NETWORK_UNAVAILABLE`, `GITHUB_REPO_UNREADABLE`, `GITHUB_ACTIONS_UNREADABLE`, `GITHUB_BRANCH_PROTECTION_UNREADABLE` and `GITHUB_OUTPUT_UNSAFE`. The doctor never mutates repository settings, never prints raw stderr, and never downloads logs or artifacts.

After pushing a validated commit, run remote CI verification:

```bash
npm run remote:ci
npm run remote:ci:proof
```

`remote:ci` is read-only and uses the GitHub CLI. It checks the current branch and commit against the `ShortsEngine CI` workflow and the `Release gate` job, then returns a safe structured summary with status, conclusion, failed job names and a GitHub run URL when it is safe. It does not download raw logs or artifacts by default.

`remote:ci` fails closed unless the remote workflow run belongs to the exact current commit SHA. The verifier reads `headSha` from `gh run view` and rejects mismatches with `REMOTE_CI_SHA_MISMATCH` instead of trusting a nearby branch run.

`remote:ci:proof` writes a safe release proof report to `release/results/remote-ci-latest.json` plus a timestamped `remote-ci-proof-*.json` file. The report includes repository owner/name, branch, commit SHA, workflow/run metadata, release-job status, failed job names only, bounded polling metadata, `logsDownloaded: false`, `artifactsDownloaded: false`, and fix-forward guidance.

When GitHub CLI is missing, auth is missing, no matching run exists or the run times out, `remote:ci:proof` still writes a safe failure proof. Failure proofs include only a structured code/message/nextAction, empty repo/commit/run fields, bounded wait metadata, and `rawLogsRequired: false` / `rawArtifactsRequired: false`.

Before writing a proof report, the proof writer validates the remote CI summary shape. Missing release-job metadata, invalid branch/SHA/run fields, unsafe URLs, local paths or secret-shaped values fail closed with structured errors instead of writing partial evidence.

Before using it, make sure `gh auth status` succeeds locally. The check fails closed when `gh` is missing, auth is unavailable, no matching run is found, the run times out, GitHub output is invalid JSON, the remote run does not match the exact commit SHA, or the summary would leak secrets/paths/provider identifiers. Missing CLI/auth failures use shared codes:

- `GITHUB_CLI_MISSING`: install GitHub CLI, then rerun `npm run github:doctor`.
- `GITHUB_AUTH_MISSING`: run `gh auth login` manually, verify `gh auth status`, then rerun remote proof.
- `GITHUB_NETWORK_UNAVAILABLE`: check network/GitHub connectivity, then rerun `npm run github:doctor`.
- `REMOTE_CI_RUN_NOT_FOUND`: wait for GitHub Actions or confirm branch/SHA.
- `REMOTE_CI_TIMEOUT`: wait for the bounded run to finish.
- `REMOTE_CI_SHA_MISMATCH`: confirm the proof is checking the pushed commit.

Missing CLI/auth failures include a safe `nextAction`; start with `npm run github:setup` when the local machine has not been prepared yet.

Remote CI polling is bounded:

```bash
SHORTSENGINE_REMOTE_CI_TIMEOUT_MS=300000 npm run remote:ci
SHORTSENGINE_REMOTE_CI_POLL_INTERVAL_MS=10000 npm run remote:ci
```

If remote CI fails, use the safe summary to identify the failed job, make a fix-forward change locally, rerun the local release chain, commit, push, and run `npm run remote:ci` again. Do not paste raw GitHub logs, tokens or artifact dumps into reports.

`npm run staging:smoke:full` is intentionally not part of the default release gate. Run it manually only with `SHORTSENGINE_STAGING_FULL_SMOKE=1` after health smoke is stable, because it uploads the fixture, creates a render job, waits for completion and downloads the resulting MP4.

`npm run staging:smoke:cleanup` is also intentionally outside the default release gate. It is dry-run by default, and real deletion requires `SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP=1`.

## Branch Protection Checklist

Enable these settings in GitHub manually:

- Require pull request before merge.
- Require the GitHub Actions job named `Release gate`.
- Require branches to be up to date before merge.
- Block force pushes.
- Block branch deletions.
- Require conversation resolution before merge.
- Keep signed commits or signed tags optional until the team explicitly adopts that policy.

The release tooling performs read-only local git remote detection and `github:doctor` can read branch protection readiness when GitHub permissions allow it. It does not mutate branch protection, repository settings, secrets or environments. If branch protection reports `unknown`, confirm the checklist in the GitHub UI before treating the branch as release-ready.

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

Review and clean up smoke artifacts manually:

```bash
npm run staging:smoke:cleanup
SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP=1 npm run staging:smoke:cleanup
```

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

Full staging smoke cleanup remains opt-in and dry-run by default. It must not run in default CI because deletion should follow a reviewed staging proof.
