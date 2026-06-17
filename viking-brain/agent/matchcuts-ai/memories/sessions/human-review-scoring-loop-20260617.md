# Session Memory: Human-Review Scoring Loop

Created: 2026-06-17T15:12:00.000Z

## Summary

- Added a human-scored side-by-side rubric for generated-vs-reference short quality.
- The rubric keeps structural machine scoring separate from operator-scored creative/product criteria.
- `npm run demo:compare` still works without a review file and reports `pending_human_review`.
- `npm run demo:compare -- --review=demo/reviews/example-side-by-side-review.json` produces `humanScore`, `combinedScore`, product readiness, failed criteria, penalties and improvement hints.
- The example review intentionally scores the current generated result as not product-ready despite a perfect structural score.

## Quality Rules

- False goal claims heavily cap the combined score.
- Wrong moment, bad crop and caption mismatch fail product readiness.
- A structurally correct `9:16` video cannot be product-ready without passing human-scored quality criteria.
- Review JSON must use safe relative refs and must not include secrets, absolute paths, raw logs, storage keys or raw provider output.

## Validation Focus

- Rubric schema validation.
- Manual review validation.
- Score bounds and unknown criteria rejection.
- Path traversal and leak rejection.
- Combined score and product readiness behavior.

## Retrieval Hints

- human-review
- quality-loop
- side-by-side-rubric
- caption-action-alignment
- football-short-product-quality
