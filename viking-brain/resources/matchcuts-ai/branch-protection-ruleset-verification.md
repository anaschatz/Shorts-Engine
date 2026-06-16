# Branch Protection + Ruleset Verification

## Context

ShortsEngine already had local release checks and remote CI proof for exact commits.
The remaining release-readiness gap was GitHub branch protection metadata returning
`unknown` when classic protection or rulesets are hidden by permissions.

## Decision

- Add read-only `branch:doctor` and `branch:proof` commands.
- Verify local commit SHA against remote `origin/main` before writing branch policy
  evidence.
- Attempt to read classic branch protection and repository rulesets.
- Treat unreadable metadata as safe `unknown` with manual GitHub UI checklist guidance.
- Never mutate branch protection, repository rulesets, secrets, Actions settings or
  remote branch state from ShortsEngine tooling.

## Expected Policy

- Required status check: `Release gate`.
- Pull request required before merge.
- Branch must be up to date before merge.
- Force pushes blocked.
- Branch deletion blocked.
- Conversation resolution required before merge.
- Direct-push/bypass actors limited to trusted operator/admin policy.

## Reports

`branch:proof` writes `release/results/branch-protection-latest.json` and a timestamped
`branch-protection-proof-*.json` report. Reports must contain only safe metadata and keep
`logsDownloaded: false`, `artifactsDownloaded: false` and `remoteMutation: false`.

