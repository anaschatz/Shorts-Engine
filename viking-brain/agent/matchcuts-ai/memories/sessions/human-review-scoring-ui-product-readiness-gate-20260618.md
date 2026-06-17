# Session Memory: Human Review Scoring UI + Product Readiness Gate

## Decisions

- Added an operator-facing human review UI instead of relying on machine metrics
  for product readiness.
- Kept routes thin by delegating review report loading/writing to the existing
  human visual review runner.
- Added safe preview streaming only for `manual-downloads/*.mp4` through
  `/api/review/media`.
- Extended critical review flags with `textBlocksAction`, `missingPayoff` and
  `reactionOnly`.
- Kept reports and API responses curated: no raw paths, storage keys, logs,
  provider output, tokens or secrets.

## Validation Plan

- Syntax checks for browser, shared validation, server and review modules.
- Focused tests for human visual review, client validation, backend API review
  errors and static UI/API contracts.
- Full release checks before commit/push: lint, build, tests, eval/reference,
  feedback summary, brain health, demo smoke/browser reports, CI reports and
  release check.

## Limitations

- Human review requires local generated/reference MP4 artifacts under
  `manual-downloads/`.
- The UI does not infer creative quality automatically; operator scoring remains
  the product readiness boundary.
