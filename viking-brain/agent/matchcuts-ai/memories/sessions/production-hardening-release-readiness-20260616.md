# Session Memory: Production Hardening Release Readiness

Created: 2026-06-16

## Summary

- Added a local static release-readiness contract.
- Exposed release readiness through `/health`.
- Included release readiness in release evidence.
- Added `npm run release:readiness` as a no-network validation command.
- Added tests for safe no-network output, missing-script fail-closed behavior and no absolute path leakage.

## Decisions

- Health must never call GitHub CLI or start auth.
- Remote CI proof remains an explicit post-push action.
- Release evidence can include static release readiness, but not raw GitHub logs, artifacts, tokens or local paths.

## Retrieval Hints

- release-readiness
- health-observability
- release-evidence
- github-proof
- no-network
