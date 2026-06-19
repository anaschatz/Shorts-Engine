# OCR QA Manifest Review Scoring

ShortsEngine now has a safe operator review layer for OCR QA manifests.

## Boundary

- `demo/run-ocr-smoke.mjs` still owns OCR smoke proof and optional crop manifest generation.
- `demo/ocr-qa-review.mjs` owns manual/operator crop QA scoring.
- `demo/run-ocr-qa-review.mjs` is a thin CLI wrapper exposed as `npm run ocr:qa:review`.
- The default runner path skips safely when no manual review input is provided, so CI does not require local OCR or human input.

## Safety Contract

- Review input references only managed manifests under `demo/results/ocr-artifacts/ocr-*/ocr-qa-manifest.json`.
- Review input accepts crop ids, boolean visibility/readability/usefulness observations, optional bounded notes and an optional operator decision.
- Reports write `demo/results/ocr-qa-review-latest.json` plus a timestamped report.
- Reports keep `logsDownloaded: false`, `artifactsDownloaded: false`, `ocrTextStored: false` and `fullFramesStored: false`.
- Reports must not contain raw OCR text, full frames, absolute paths, local crop paths, stdout/stderr, provider output, tokens, storage keys or secrets.

## Calibration

- OCR QA review is `goalEvidencePolicy: support_only`.
- High-quality OCR crops can become strong supporting evidence only when paired with football action evidence.
- Low-quality or unreadable crops are ignored/downweighted.
- OCR evidence alone must never confirm a goal or override offside/no-goal context.

## Release Gate

- CI runs `npm run ocr:qa:review` in skipped-safe mode after `npm run ocr:smoke`.
- `npm run ci:reports` validates `demo/results/ocr-qa-review-latest.json`.
- Failure artifacts may upload the latest safe review report, but never the OCR crop artifact directory.
