# Session Memory: report-log-key-family-hardening-20260617

Created: 2026-06-17T00:00:00.000Z

## Summary

Hardened report-safety and structured log redaction so credential-shaped object keys
are rejected or redacted even when their values are not obviously secret-shaped.

## Decisions

- `findSensitiveLeak` now treats key families like `clientSecret`, `refreshToken`,
  `privateKey`, `accessKeyId`, `sessionToken`, raw stdout/stderr and path fields as
  unsafe.
- `redactForLogs` now redacts the same key families in nested structured log objects.
- Readiness booleans such as `credentialsConfigured`, `tokensRequested`,
  `secretsIncluded`, `logsDownloaded` and `artifactsDownloaded` remain allowed.

## Tests

- Added report leak-guard regression coverage in `tests/demo-smoke.test.mjs`.
- Added structured log redaction regression coverage in `tests/object-storage.test.cjs`.
