# Session Memory: Reference Video Comparison + Visual QA Loop

Date: 2026-06-21

Decision:

- Added `npm run compare:reference` as the next QA loop after live YouTube proof generation.
- Kept reference videos metadata-only by default; no external MP4 download or repo-stored copyrighted reference assets.
- Added a safe HTML side-by-side artifact for operator review without redesigning the app UI.

Implementation notes:

- `eval/reference-comparison.cjs` extracts generated proof metrics from the latest live proof.
- `eval/reference-comparison-fixtures/football-multi-goal-reference.json` defines the multi-goal football reference expectations.
- Reports include goal coverage, replay discipline, aspect ratio, crop safety, phase coverage, pacing, cut smoothness, caption alignment, transition polish, motion density and aggregate reference similarity.

Safety:

- Reports and HTML artifacts use safe relative refs only.
- Reference URLs are validated as HTTPS and secret-like query params are rejected.
- Missing proof/fixture inputs fail closed with safe operator recovery.
- No logs, artifacts, tokens, provider raw output, absolute paths or storage keys are exposed.

Next limitation:

- The comparison is metadata-first unless the operator supplies a local reference video. Human taste scoring is still handled by the existing human review flow.
