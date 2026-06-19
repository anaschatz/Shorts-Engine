# OCR QA Calibration Integration

## Decision

Manual OCR QA review is now consumed by the backend through `server/ocr-qa-calibration.cjs`.

The calibration is support-only:

- Missing, skipped, stale, invalid or leaking reports keep `usable: false` and `decisionSupportLevel: ignore`.
- Usable reports can support scoreboard OCR score-change or score-unchanged evidence only next to football action evidence.
- OCR QA cannot set `goalDecisionAllowed` and cannot confirm goals without visual ball-in-net/action context.
- Public job/eval outputs expose only safe calibration summaries, never manifest internals, crop paths, raw OCR text or provider output.

## Integration Points

- `server/render-job.cjs` loads the latest OCR QA calibration after scoreboard OCR and passes it into goal evidence analysis.
- `server/goal-evidence-provider.cjs` gates OCR reason codes with the calibration before resolving valid-goal/offside/no-goal evidence.
- `eval/scoring.cjs` supports fixture-level `ocrQaCalibration` and reports `ocrQaCalibrationSupport`.

## Tests

- `tests/ocr-qa-calibration.test.cjs` covers strong support, skipped/stale/invalid/leaking reports, path safety and OCR-only no-goal behavior.
- `tests/render-job.test.cjs` verifies orchestration passes calibration to the goal-evidence adapter.
- `tests/eval.test.cjs` verifies OCR QA support metrics and report shape.

## Limitation

The current calibration scores crop usefulness and readability, not match truth. It improves confidence handling for OCR, but valid goal discovery still depends on visual football evidence, transcript context and provider/fallback signals.
