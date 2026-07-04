# Session Memory: auth-project-ownership-boundary-20260704

Created: 2026-07-04T00:00:00.000Z

## Summary

Added an auth and project ownership boundary for ShortsEngine so protected API
routes no longer expose uploads, jobs, exports, downloads, or YouTube ingest flows
without an authenticated operator principal.

## Decisions

- Added `server/auth.cjs` with operator/local modes, weak token rejection,
  timing-safe bearer token checks, safe public auth health, and owner assertions.
- Default auth mode is `operator`; staging/production require
  `SHORTSENGINE_OPERATOR_AUTH_TOKEN`.
- Local anonymous mode is explicit and blocked in staging/production.
- Project/upload/job/export records now carry `ownerId` through repositories,
  SQLite persistence, YouTube ingest, regeneration approval, render jobs, and
  downloads.
- Download and signed artifact routes require auth plus owner access.
- SQLite repository health table reads now use a fixed allowlist.
- Environment/release readiness now validates the auth contract without exposing
  token values.

## Tests

- Added `tests/auth-boundary.test.cjs` for missing auth, valid/invalid operator
  auth, local-mode production rejection, job owner isolation, and export download
  authorization.
- Extended environment tests for operator token readiness, staging/production
  auth failures, and no secret leakage.
- Extended SQLite persistence tests for repository health SQL allowlisting.

## Limitations

- Global review/OCR helper reports require auth but still use report-level refs,
  not per-project owner metadata. A later milestone should attach owner/project
  metadata to generated review artifacts before enforcing per-owner filtering.
