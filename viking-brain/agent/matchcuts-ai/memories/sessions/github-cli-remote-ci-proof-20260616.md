# Session Memory: GitHub CLI Remote CI Proof

Created: 2026-06-16

## Summary

- Hardened `remote:ci` to use shared `GITHUB_CLI_MISSING` and `GITHUB_AUTH_MISSING` recovery codes.
- Added exact run-to-commit verification by comparing `gh run view` `headSha` with the local HEAD SHA.
- Added bounded wait metadata to remote CI summaries and proof reports.
- Extended `remote:ci:proof` so missing CLI/auth/no-run/timeout/SHA mismatch can write safe failure evidence.
- Updated docs, static checks and tests for no logs/artifacts, no mutation and no secret/path leakage.

## Decisions

- Remote proof remains explicit and post-push only.
- `/health` and `release:readiness` remain no-network and no-auth.
- Failure proof reports are allowed only when they contain safe structured codes and no raw GitHub output.
- A remote run must match the exact pushed commit before it can pass release proof.

## Retrieval Hints

- github-cli
- remote-ci-proof
- exact-sha
- failure-evidence
- release-gate
