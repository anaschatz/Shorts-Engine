# GitHub CLI Remote CI Proof

ShortsEngine remote CI proof is an explicit post-push release check.

## Commands

- `npm run github:setup`
- `npm run github:doctor`
- `npm run remote:ci`
- `npm run remote:ci:proof`

## Contract

`remote:ci` uses GitHub CLI in read-only mode to inspect the `ShortsEngine CI` workflow and `Release gate` job for the current branch and exact commit SHA.

The verifier must:

- Detect missing GitHub CLI as `GITHUB_CLI_MISSING`.
- Detect missing auth as `GITHUB_AUTH_MISSING`.
- Detect doctor network reachability failures as `GITHUB_NETWORK_UNAVAILABLE`.
- Detect GitHub/network reachability failures as `REMOTE_CI_NETWORK_UNAVAILABLE`.
- Distinguish pending, passed, failed and cancelled workflow states.
- Never start `gh auth login`.
- Never mutate GitHub settings.
- Never download Actions logs or artifacts by default.
- Reject any run whose `headSha` does not match the current commit with `REMOTE_CI_SHA_MISMATCH`.
- Return safe JSON with bounded polling metadata.

`github:setup` remains documentation-only and should include official install links, manual `gh auth login` guidance, expected repository `anaschatz/Shorts-Engine`, expected workflow/job names and read-only access requirements.

`github:doctor` should return safe `phase`, `status`, `passed`, `skipped` and `nextAction` fields for missing CLI, missing auth, network unavailable, unreadable repo, unreadable Actions metadata, branch-protection unknown/unreadable and unsafe output.

## Proof Reports

`remote:ci:proof` writes:

- `release/results/remote-ci-latest.json`
- timestamped `release/results/remote-ci-proof-*.json`

Successful and failed workflow results include repository, branch, commit, workflow, release-job, failed-job and polling metadata.

All proof reports also include top-level `command`, `phase`, `status`, `passed`, `skipped`, `nextAction` and `triage` fields for report-driven triage.

Missing CLI, missing auth, no-run, timeout and SHA mismatch cases write safe failure evidence with only:

- failure code
- safe message
- next action
- `logsDownloaded: false`
- `artifactsDownloaded: false`
- `rawLogsRequired: false`
- `rawArtifactsRequired: false`

## Safety

Do not include local paths, storage keys, tokens, env vars, raw stderr, raw GitHub logs or downloaded artifacts in proof reports.

Health and `release:readiness` stay local static checks; they must not call GitHub CLI or perform network/auth work.
