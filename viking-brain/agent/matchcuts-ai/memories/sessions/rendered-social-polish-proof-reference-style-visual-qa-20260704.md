# Session Memory: Rendered Social Polish Proof + Reference-Style Visual QA

Date: 2026-07-04

## Decisions

- Added a rendered social polish proof layer so release/demo proof cannot rely on JSON edit-plan metrics alone.
- The proof combines fresh MP4 metadata, FFprobe, video-output QA, render polish QA, visible phase coverage and rights-safe style policy.
- Live YouTube proof now has a strict social-polish failure path: `YOUTUBE_LIVE_E2E_SOCIAL_POLISH_FAILED`.
- Local video proof now fails closed and discards the output artifact if rendered social polish QA fails.

## Validation Added

- Fresh proof never accepts unsafe, stale or `latest` MP4 references.
- Hook must start immediately and end inside the first two seconds with evidence and no false goal claim.
- Captions must render word-by-word active highlight timing, not fallback static captions.
- Smooth editing checks hard-cut fallback and multi-segment transition coverage.
- Phase visibility rejects replay-only, celebration-only and non-goal filler segments.

## Tests

- Added `tests/rendered-social-proof.test.cjs`.
- Updated YouTube runtime and local proof tests to assert dynamic word caption reporting and rendered social proof pass behavior.

## Limitation

- The proof verifies contracts exposed by render summaries and FFprobe. Full pixel-level OCR of captions in the generated MP4 remains a future visual QA improvement.
