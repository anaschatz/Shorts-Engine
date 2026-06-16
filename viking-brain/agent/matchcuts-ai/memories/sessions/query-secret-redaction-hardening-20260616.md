# Session Memory: query-secret-redaction-hardening-20260616

Created: 2026-06-16T20:30:00.000Z

## Summary

Added a scoped production hardening pass for report/log leak prevention. The project now
treats URL query credentials as sensitive, including external `token` params, OAuth
tokens, S3 session-token query params and GCS signed URL params.

## Decisions

- Keep report safety and server log redaction aligned for query-string credentials.
- Preserve the internal artifact download URL exception path under explicit signed-token
  handling so public API response tests can inspect the shape without persisting tokens.
- Add tests and static lint to prevent regression.

## Validation Plan

Run lint, build, tests, eval, brain health, CI report validation, release check and
remote CI proof before final delivery.

