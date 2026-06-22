# Session Memory: Live Counted-Goal Evidence Recovery

Created: 2026-06-22

## Summary

Added fail-closed diagnostics for live YouTube counted-goal proof. The system now exposes scoreboard/OCR attempted/enabled state, observation counts, stable score-change counts, counted-goal event counts, missing evidence per candidate and safe next actions when valid-goals-only rendering cannot produce a plan.

## Decisions

- Keep YouTube ingest and scoreboard OCR disabled by default.
- Add live proof OCR through explicit operator flags only.
- Do not infer goals from chances, crowd reaction, shot motion, or goal-area context.
- Do not create an MP4 when counted-goal evidence is missing or when ingest/download fails.
- Pre-render failures must keep their real phase/code/nextAction instead of pointing at OCR.
- Generated OpenViking test noise should be restored instead of committed.

## Validation

- Full local checks passed, including lint, build, 718 tests, eval, reference eval, demo smoke, browser smoke, Playwright browser smoke, report gate, release gate and brain health.
- Live proof was attempted with explicit rights and OCR flags for `gxiRyFZXJV8`. It failed safely due to environment/downloader conditions and generated no MP4.

## Limitation

The live proof did not reach the OCR/evidence stage on the final run because the downloader failed before upload/job creation. A rights-cleared local MP4 or fixed downloader environment is required to validate actual 3/3 counted-goal evidence in the render pipeline.
