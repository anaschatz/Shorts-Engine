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
- Never start `gh auth login`.
- Never mutate GitHub settings.
- Never download Actions logs or artifacts by default.
- Reject any run whose `headSha` does not match the current commit with `REMOTE_CI_SHA_MISMATCH`.
- Return safe JSON with bounded polling metadata.

## Proof Reports

`remote:ci:proof` writes:

- `release/results/remote-ci-latest.json`
- timestamped `release/results/remote-ci-proof-*.json`

Successful and failed workflow results include repository, branch, commit, workflow, release-job, failed-job and polling metadata.

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
