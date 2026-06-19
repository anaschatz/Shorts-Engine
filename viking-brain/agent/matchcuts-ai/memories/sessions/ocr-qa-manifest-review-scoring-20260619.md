# OCR QA Manifest Review Scoring - 2026-06-19

## Decisions

- Added an opt-in OCR QA review runner for manifests created by `SHORTSENGINE_OCR_QA_ARTIFACTS=1 npm run ocr:smoke`.
- Kept the default CI/release path safe by allowing `npm run ocr:qa:review` to skip without manual input.
- Kept OCR QA calibration support-only: OCR crop quality can support goal/offside evidence but cannot confirm a goal by itself.
- Added report safety checks so review reports avoid raw OCR text, full frames, local paths, provider output, stdout/stderr, tokens and secrets.

## Files

- `demo/ocr-qa-review.mjs`
- `demo/run-ocr-qa-review.mjs`
- `tests/ocr-qa-review.test.mjs`
- `demo/validate-ci-reports.mjs`
- `.github/workflows/ci.yml`
- `tools/release/verify-release-gate.mjs`
- `docs/ENVIRONMENT.md`
- `demo/CI.md`
- `docs/RELEASE.md`

## Validation Intent

- Focused tests cover safe manifest refs, unsupported raw OCR fields, note leak guards, deterministic scoring, low-quality downweighting, writer output and skipped-safe runner behavior.
- Full validation should include lint, build, tests, eval, reference eval, OCR doctor/smoke, OCR QA review, browser/demo smoke, CI reports, release check, brain health, commit/push and remote CI proof.

## Limitations

- Manual review is still an operator calibration loop; it does not parse raw OCR text and does not claim match truth.
- Real goal/offside decisions still require visual football action evidence plus appropriate goal/offside evidence gates.
