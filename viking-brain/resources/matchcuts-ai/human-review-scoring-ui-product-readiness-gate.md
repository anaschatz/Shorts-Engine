# Human Review Scoring UI + Product Readiness Gate

## Purpose

ShortsEngine now has an operator-facing human review gate for generated shorts.
Machine structural metrics can prove that a render exists and is readable, but
they must not mark a video as product-ready without explicit human scoring.

## Contracts

- `GET /api/review/latest` returns the latest safe human visual review summary.
- `POST /api/review/human` accepts explicit operator scores and writes
  `demo/results/human-visual-review-latest.json` plus a timestamped report.
- `/api/review/media?ref=...` previews only safe `manual-downloads/*.mp4`
  references.
- Public responses are curated and must not include local absolute paths,
  storage keys, raw logs, provider output, tokens or secrets.
- `productReady` is true only when a valid human review is present and all
  critical criteria/flags pass.

## Critical Flags

These flags block product readiness even when the structural score is high:

- `falseGoalClaim`
- `wrongMoment`
- `badCrop`
- `captionMismatch`
- `textBlocksAction`
- `missingPayoff`
- `reactionOnly`

## UI Notes

The UI renders score controls from the shared `HUMAN_REVIEW_CRITERIA` contract
and flag toggles from `HUMAN_REVIEW_FLAGS`. It validates refs, criterion scores,
flags and notes before submit, shows safe errors, and keeps previews bounded in
a responsive two-column layout that collapses on small screens.

## Tests

Coverage should include API payload validation, critical-flag readiness gating,
latest pending report behavior, client-side payload validation, static route/UI
contracts and leak guards.
