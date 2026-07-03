# Scorebug OCR Calibration + Stable Score Change Recovery

## Purpose

Long YouTube proof must not fail with `0` score changes and no explanation. The scorebug-first OCR path should scan bounded chunks, expose safe ROI diagnostics and preserve enough timeline detail to explain whether the blocker is ROI placement, unreadable OCR, clock-only text, timeout or missing visual/live-phase support.

## Runtime Contract

- Long-source YouTube analysis uses chunked scorebug-first OCR before visual frame extraction.
- Scorebug-first OCR uses a bounded ROI set:
  - `scorebug_broadcast_compact`
  - `scorebug_left_compact`
  - `scoreboard_top_left`
  - `scoreboard_top_center`
  - `scoreboard_top_right`
- The broad `broadcast_top_band` region is excluded from scorebug-first runtime scans to reduce timer/team-label noise and per-chunk cost.
- Scorebug-first preprocessing is bounded to the safer `gray_line` and `contrast_block` variants.
- Each chunk report should include sampled timestamps, ROI candidates, selected ROI, readable/text/clock/rejected counts, normalized score candidates, rejected reasons, stable score decision and next action.

## Safety Rules

- OCR remains support evidence. OCR-only score changes must not create renderable goal segments without visual/live-phase support.
- Reports must not include raw OCR stdout/stderr, local paths, cookies, tokens, full frame dumps or storage keys.
- Timeouts and skipped chunks must be structured and non-misleading.
- If no final MP4 can be proven against the output gate, live proof must fail closed and explain the missing evidence.

## Validation Expectations

- Focused tests should cover scorebug-first bounded ROI/variant behavior, long-source chunk diagnostics, late score changes and safe live proof report propagation.
- Full release validation should still run lint, build, tests, eval, reference eval, YouTube doctor, OCR smoke/review, CI reports, release check, brain health and remote CI proof after push.
