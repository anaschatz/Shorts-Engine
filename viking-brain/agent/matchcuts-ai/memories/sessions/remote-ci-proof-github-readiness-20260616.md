# Session Memory: Remote CI Proof + GitHub Release Readiness

Created: 2026-06-16

## Summary

- Added GitHub CLI doctor coverage for `gh`, auth, repository readability, Actions metadata and branch-protection readiness.
- Added remote CI proof generation so post-push checks can write `release/results/remote-ci-latest.json` and timestamped proof reports.
- Proof reports include safe release-job status and fix-forward guidance without raw logs or artifacts.
- Branch protection remains read-only: verified when GitHub exposes it, otherwise `unknown` with UI confirmation as next action.

## Decisions

- Keep `github:doctor`, `remote:ci` and `remote:ci:proof` outside the default CI gate.
- Do not add GitHub tokens or remote mutation scripts.
- Do not download GitHub Actions logs or artifacts by default.
- Keep tests mocked and deterministic.

## Retrieval Hints

- github-doctor
- remote-ci-proof
- release-readiness
- branch-protection
- fix-forward
