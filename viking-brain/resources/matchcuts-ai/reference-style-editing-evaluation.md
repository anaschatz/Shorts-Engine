# Reference-Style Editing Evaluation

Milestone: Reference-Style Editing Evaluation + Side-by-Side Quality Review.

Purpose:
- Compare ShortsEngine candidate edit plans against a deterministic football-shorts reference rubric.
- Measure whether captions, pacing, framing, animations and moment selection move toward the target style instead of adding effects blindly.
- Keep the review local, no-network and API-key-free.

Implemented contracts:
- `eval/reference-rubric.cjs` scores reference quality with weighted metrics:
  - moment relevance
  - no false goal claim
  - caption/action alignment
  - caption role sequence
  - caption readability
  - text safe-area risk
  - animation cue relevance
  - pacing and duration sanity
  - framing safety
  - aspect ratio correctness
  - hook strength
  - replay/outro usefulness
- `eval/reference-fixtures/` contains synthetic football reference cases for chance, crowd reaction, save, foul, counter, replay, scoreboard-only context and high-noise commentary.
- `eval/run-reference-review.mjs` writes safe JSON reports to `eval/results/`.
- `npm run eval:reference` is deterministic and requires no network or provider keys.

Safety decisions:
- False goal claims are an explicit hard penalty for no-goal fixtures.
- Crowd noise, commentary spikes and scoreboard/goal-area context are not goal evidence.
- Reference review uses edit-plan metadata rather than heavy video inspection.
- Reports must not include secrets, raw provider output, local absolute paths or storage keys.

Next use:
- Run `npm run eval:reference` after changes to football story planning, captions, animation cues, framing or highlight ranking.
- Treat low caption/action alignment as a product-quality signal, not a schema failure.
