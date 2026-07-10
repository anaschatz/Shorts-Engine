# Session Memory: Ball-First Dynamic Auto-Framing + Scoreboard Composition

## Decisions

- Added a deterministic local FFmpeg football-tracking adapter with bounded frame decoding and no external provider requirement.
- Added ball-first crop timelines with player-cluster fallback, hysteresis, conservative movement, and wide-safe fallback.
- Refined tracking around every final goal segment so sparse full-source samples cannot miss the actual finish.
- Mapped source-time crop keyframes into the concatenated output timeline before rendering.
- Suppressed the original scorebug region and rendered one synchronized source scorebug overlay above the dynamic crop.
- Preserved internal render-polish QA metadata after edit-plan validation so public proof reports match the strict gate decision.

## Validation Snapshot

- Research baseline: quality `98.2`.
- Research experiment: `discard`, score delta `0`, no guardrail regressions; the rubric is pixel-blind for this change.
- Focused render orchestration tests: `52/52` passed after the final reporting fix.
- Full test suite, lint, build, eval, reference eval, demo smoke, browser smoke, Playwright smoke, CI report validation, and release check passed.
- Eval aggregate: `98`; reference eval aggregate: `98`.
- Fresh live proof: five counted goals, five covered goals, no missing goal numbers.
- Final MP4: `1080x1920`, H.264/AAC, `111.75` seconds, 87,974,399 bytes.
- Human inspection confirmed all five goal sequences, dynamic full-screen football framing, and a single visible source scoreboard.

## Limitations

- Automated finish/payoff role selection can be later than the actual finish for goals 1 and 5; segment-level human visibility is correct, but semantic timestamp precision should improve.
- The new local tracker is deterministic and bounded, not a full learned football detector.
- Live YouTube ingest and proof remain explicit rights-confirmed operator actions and are disabled by default.
