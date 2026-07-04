# Auth + Project Ownership Boundary

## Purpose

ShortsEngine now treats projects, uploads, jobs, exports, and signed export delivery
as operator-owned resources. Protected API routes must authenticate first, then
authorize access against the resource owner before returning data or triggering
work.

## Runtime Contract

- `SHORTSENGINE_AUTH_MODE=operator` is the default.
- `SHORTSENGINE_OPERATOR_AUTH_TOKEN` is required in staging/production operator mode.
- `SHORTSENGINE_AUTH_MODE=local` is only for explicit local tests/demos and is
  rejected in staging/production.
- Protected requests use `Authorization: Bearer <token>` or the ShortsEngine
  operator token header aliases.
- Public health returns only readiness booleans and mode metadata, never tokens.

## Ownership Contract

- Upload/project creation stamps `ownerId` from the authenticated principal.
- YouTube ingest stamps upload/project records with the same owner.
- Generate jobs inherit the authenticated owner.
- Completed exports inherit the job/project owner.
- Download and signed artifact routes require both valid auth and matching owner.
- Operator mode fails closed for legacy records without owner metadata; local mode
  can read unowned records for migration/demo compatibility.

## Safety Notes

- Tokens are hashed with SHA-256 for comparison and checked using timing-safe equality.
- Weak token configuration is rejected.
- Public responses must not leak authorization headers, token values, raw errors,
  local paths, or stack traces.
- SQLite repository health uses an allowlist for table names.
