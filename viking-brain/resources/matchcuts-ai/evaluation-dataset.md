# Evaluation Dataset L2 Details

Source files:

- `eval/fixtures/*.json`
- `eval/scoring.cjs`
- `eval/run-eval.mjs`
- `eval/README.md`
- `tests/eval.test.cjs`

Current dataset:

- 6 synthetic football fixtures covering goal/audio peak, keeper save, tactical assist, replay/crowd reaction, Greek commentary and late winner moments.

Metrics:

- Top-1 overlap with expected highlight window.
- Top-3 recall.
- Reason-code precision and recall.
- Retention score sanity.
- Candidate edit-plan validity.
- Caption timing validity.
- Fallback usage rate.
- Aggregate score 0-100 with per-fixture pass/fail thresholds.

Operating rule:

- Run `npm run eval` after changing analysis ranking, reason codes, captions, edit-plan validation or fixtures.
- Reports are written to `eval/results/` and should not include secrets, raw provider errors or local absolute paths.
