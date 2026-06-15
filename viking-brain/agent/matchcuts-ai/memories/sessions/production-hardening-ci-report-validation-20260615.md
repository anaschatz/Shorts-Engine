# Session: Production Hardening CI Report Validation

Date: 2026-06-15

Milestone:

- Added `npm run ci:reports` as a release-gate report validation step.
- Added a deterministic local validator for the latest demo, browser, Playwright and eval reports.
- Wired the validator into the GitHub Actions release gate after browser CI.
- Updated demo CI docs and demo README with the report safety contract.
- Added focused tests for report freshness, leak detection, safe report refs and failure-only Playwright artifacts.

Decisions:

- Treat generated reports as evidence that must be validated, not just files produced by prior commands.
- Fail closed when a report is missing, stale, failed, leaky, invalid or contains unsafe relative references.
- Keep Playwright trace/video disabled in the default release gate.
- Require passing Playwright runs to have no managed browser failure artifacts.
- Keep real cloud integration out of the default release gate.

Focused checks passed during implementation:

- `npm run lint`
- `node --test --test-concurrency=1 tests/ci-reports.test.mjs`
- `npm run ci:reports`

Limitations:

- GitHub Actions itself was not executed from the local workspace.
- Remote branch protection remains a repository-hosting setting.
