# Session Memory: Real Video Review Loop

Date: 2026-06-17

## Decision

Added a deterministic real-video review loop instead of turning manual side-by-side review into a release gate. The new layer lives under `eval/` and compares generated short metadata plus safe media refs against expected moment/style/caption/framing constraints.

## Implementation

- Added `eval/review-comparison.cjs`.
- Added CLI scripts:
  - `npm run review:compare`
  - `npm run review:summary`
- Added default fixture:
  - `eval/review-fixtures/demo-reference-style-review.json`
- Added local ignored output folder:
  - `eval/review-results/`
- Added focused tests:
  - `tests/review-comparison.test.cjs`
- Added resource:
  - `viking-brain/resources/matchcuts-ai/real-video-review-loop.md`

## Safety

- Media refs are workspace-relative only.
- Missing media, path traversal, unsupported extensions and missing rights confirmation fail closed.
- Reference video is optional only when `referenceStyleFallbackAllowed` is true.
- Reports contain no absolute local paths, tokens, storage keys, raw logs, raw provider errors or raw artifacts.
- Reports declare `logsDownloaded: false`, `artifactsDownloaded: false`, `rawProviderOutputIncluded: false`, and `trainingDataMutation: false`.

## Metrics

The report tracks:

- `momentTypeMatch`
- `noFalseGoalClaim`
- `captionActionAlignment`
- `captionSpecificity`
- `framingSafety`
- `aspectRatioCorrectness`
- `pacingScore`
- `animationCueCoverage`
- `referenceStyleSimilarity`
- `reviewerReadinessScore`
- `overallScore`

## Initial Result

Default fixture passed locally with `overallScore: 99`, `noFalseGoalClaim: 1`, `captionActionAlignment: 1`, `framingSafety: 1`, and `referenceStyleSimilarity: 1`.

## Limitation

The default fixture uses metadata and the committed demo source video. Real operator reference videos remain local-only and should be added as workspace-relative refs in ignored/manual media locations, not committed.
