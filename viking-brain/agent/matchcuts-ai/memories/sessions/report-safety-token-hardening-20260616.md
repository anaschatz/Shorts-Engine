# Report Safety Token Hardening - 2026-06-16

## Decision

ShortsEngine release, CI, demo and YouTube proof reports use the shared `demo/report-safety.mjs` leak guard before persistence.

This pass expanded the guard and server log redaction to catch:

- GitHub app/OAuth token variants
- GitLab personal access tokens
- Slack tokens
- private-key blocks
- YouTube cookie values
- raw log, cookie, credential and token fields

## Rationale

Remote proof and YouTube operator flows are intentionally safe summaries, but failures can still receive provider/downloader/CLI text from real machines. These values must fail closed before writing JSON reports and must be redacted before structured logs are emitted.

## Validation

- `tests/demo-smoke.test.mjs` covers the leak guard.
- `tests/object-storage.test.cjs` covers log redaction.
- `tests/static-lint.mjs` keeps the report-safety contract present.

## Limitation

This pass does not inspect binary artifacts or screenshots; browser artifacts remain failure-only and controlled by the existing CI artifact allowlist.
