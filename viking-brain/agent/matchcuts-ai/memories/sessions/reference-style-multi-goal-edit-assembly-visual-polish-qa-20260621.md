# Reference-Style Multi-Goal Edit Assembly + Visual Polish QA - 2026-06-21

## Decisions

- Kept the counted-goal truth layer as the source of selection authority. The visual polish pass is additive and cannot promote offside, no-goal, replay-only, or celebration-only windows into counted goals.
- Normalized `buildupStart` through the edit-plan boundary so goal segments can prove that they include setup before shot/finish.
- Added chronological edit assembly metadata for multi-goal shorts, including smooth transition duration and cut reasons between goal segments.
- Added `visualPolishQA` to analysis plans and live YouTube proof summaries so generated videos can be compared with reference-style expectations using stable metrics.
- Extended eval scoring with visual polish and abrupt-cut metrics while preserving existing valid-goal recall and false-goal gates.

## Verification

- Focused syntax checks passed for the touched server, demo, and eval modules.
- Focused tests passed for analysis, YouTube runtime proof summaries, and eval scoring.
- `npm run eval` passed with aggregate score 98 before the final full-check pass.

## Limitations

- The current milestone verifies assembly quality and QA reporting. It does not yet implement full creator-style motion graphics, pixel-level side-by-side aesthetic scoring, or advanced beat-synced transitions.
- Generated MP4s, OCR crops, live proof reports, and eval reports remain generated artifacts and should stay out of commits.
