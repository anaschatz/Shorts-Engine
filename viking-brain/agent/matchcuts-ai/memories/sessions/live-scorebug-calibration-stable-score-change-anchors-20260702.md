# Session Memory: Live Scorebug Calibration Stable Score Change Anchors

Created: 2026-07-02

## Summary

Added an explicit score change anchor contract around match-event truth and YouTube proof reporting. Stable OCR scorebug changes now carry safe timing, source and evidence metadata, and the public proof path can distinguish stable counted anchors from reverted or visually unsupported score changes.

## Decisions

- Keep scorebug OCR as evidence, not as a standalone goal claim.
- Require visible live action and visible finish support before a score change anchor is selected for render.
- Treat reverted score changes as disallowed/no-goal context.
- Surface score change anchor summaries in render logs and YouTube proof reports without raw OCR output, local paths, storage keys or provider errors.
- Keep live YouTube proof opt-in and fail closed when rights, ingest flags or downloader readiness are missing.

## Validation

- Focused match-event truth and YouTube runtime tests pass.
- Focused render job, goal evidence provider and scoreboard OCR tests pass.

## Limitations

- This improves anchor observability and selection safety; real live YouTube proof still depends on opt-in operator flags, downloader readiness and readable broadcast scorebugs.
- OCR-only anchors without visual phase support remain rejected by design.
