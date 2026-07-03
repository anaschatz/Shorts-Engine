# Session Memory: Long YouTube Ingest Reliability + Authorized Download Runtime

## Decisions

- Kept YouTube ingest opt-in and rights-gated.
- Did not add cookies, tokens, browser auth import or platform bypass behavior.
- Fixed the live proof timeout mismatch by computing smoke request timeout from downloader per-attempt timeout and attempt count.
- Added safe ingest diagnostics to adapter/service/API/smoke/live proof reports.
- Preserved fail-closed behavior: no MP4 is reported when ingest fails.

## Safety Notes

- Public diagnostics are scalar and sanitized.
- Cleanup is best-effort but constrained to managed staging paths.
- Generated MP4s and reports should not be staged.

## Validation Target

- Run lint, build, tests, eval, reference eval, YouTube doctor, live proof, CI reports, release check and brain health.
- Commit and push only after validation, then verify remote SHA and remote CI proof.
