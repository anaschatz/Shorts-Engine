# Session Memory: YouTube Downloader Runtime Reliability

Created: 2026-07-03

## Summary

Added a safer YouTube downloader runtime layer for authorized source fetch proof. The local downloader adapter now supports bounded retry/fallback format strategy, clears partial staged MP4 files between attempts, exposes safe attempt metadata and keeps live proof failures structured before OCR/render work.

## Decisions

- Keep YouTube ingest opt-in and rights-gated.
- Use only `execFile` with explicit args; no shell strings, cookies, browser sessions, tokens or raw extractor args.
- Add bounded config for primary/fallback format selectors, download attempts and retry backoff.
- Let `youtube:doctor` report downloader readiness, version and sanitized format strategy.
- Surface safe downloader attempt metadata in API/smoke/live proof reports without raw stdout/stderr or local paths.

## Validation

- Focused YouTube ingest, YouTube runtime and environment tests pass.
- Full validation should include lint, build, full test suite, eval, reference eval, YouTube doctor, OCR smoke/review, CI reports, release check, brain health and remote CI proof after push.

## Limitations

- This does not bypass YouTube bot/auth/cookie gates.
- Real source fetch can still fail in operator environments; those failures should now be more actionable and non-misleading.
