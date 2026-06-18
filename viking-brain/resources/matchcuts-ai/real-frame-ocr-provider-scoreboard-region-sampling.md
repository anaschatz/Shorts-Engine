# Real Frame OCR Provider + Scoreboard Region Sampling

## Boundary
- `server/scoreboard-ocr.cjs` owns scoreboard/OCR sampling and validation.
- The default mode is deterministic local fallback; optional external OCR stays behind an adapter and is disabled by default.
- Render orchestration calls scoreboard OCR after sampled frame/visual tracking and before goal evidence analysis.

## Safety Rules
- OCR never decides a valid goal by itself.
- A score change can support valid-goal evidence only when paired with ball-in-net/action context and temporal consistency.
- Ambiguous OCR fails closed and can only produce decision-unclear context.
- OCR-only score changes without ball-in-net context stay non-goal.
- Public reports/logs expose bounded counts only: no raw OCR dumps, frame paths, storage keys, stdout/stderr, tokens or provider errors.

## Evaluation
- Added fixtures for ambiguous OCR fail-closed and OCR-only score-change no-goal.
- Updated no-goal fixtures to expect explicit provider evidence reasons (`non_goal_chance`, `shot_sequence_support`).
- Updated the visual-only ball-in-net fixture to expect `big_chance`/decision-unclear behavior unless explicit goal confirmation exists.
- Eval gates include `ocrEvidenceCoverage`, `scoreboardScoreChangeRecall`, `ambiguousOcrFailClosed` and `noFalseGoalFromOcrOnly`.

## Observability
- Health exposes `scoreboardOcr` readiness as degraded fallback by default.
- Render logs include `scoreboard_ocr_completed` with provider mode, fallback, sampled frame count, evidence count, score-change count and ambiguous count.
