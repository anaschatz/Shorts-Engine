# Session Memory: Remote CI Verification Loop

Created: 2026-06-16

## Summary

- Added a read-only remote CI verifier around GitHub CLI for post-push release gate checks.
- The verifier polls the `ShortsEngine CI` workflow for the current branch/SHA and reports the `Release gate` job status without downloading raw logs or artifacts.
- Output is bounded, structured and checked with the shared report-safety leak guard.
- Remote failures should be handled by fix-forward commits after rerunning local validation.

## Decisions

- Keep `remote:ci` out of the default GitHub Actions workflow.
- Do not add GitHub tokens to the repo or custom API clients.
- Treat missing `gh`, missing auth, missing runs, invalid JSON and timeouts as safe non-zero failures.

## Retrieval Hints

- remote-ci
- release-gate
- github-actions
- fix-forward
- report-safety
