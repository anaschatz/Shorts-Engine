# Session Memory: GitHub CLI Enablement + Remote CI Proof Activation

Created: 2026-06-16

## Summary

- Added `npm run github:setup` as a documentation-only GitHub CLI setup helper.
- The helper explains install/auth/post-push proof flow without running auth, calling network APIs, requesting tokens, mutating GitHub settings or downloading logs/artifacts.
- Added safe `nextAction` guidance for missing GitHub CLI/auth and remote CI missing-run/timeout failures.
- Added deterministic tests and static contracts for setup output, no-leak behavior and safe failure guidance.

## Decisions

- Keep `gh auth login` as a manual user action outside project automation.
- Keep remote CI proof post-push and read-only.
- Treat branch-protection `unknown` as a UI confirmation task, not an automation task.
- Keep all default tests mocked and no-network.

## Retrieval Hints

- github-setup
- github-doctor
- remote-ci-proof
- post-push-validation
- release-readiness
