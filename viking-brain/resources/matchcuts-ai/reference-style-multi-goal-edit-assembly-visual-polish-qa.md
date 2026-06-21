# Reference-Style Multi-Goal Edit Assembly + Visual Polish QA

## Purpose

ShortsEngine should keep the counted-goal truth gate intact while making the generated multi-goal short easier to review against reference football shorts. This resource records the edit assembly and visual polish QA contract added after the 3/3 counted-goal live proof work.

## Contract

- Counted-goal selection remains truth-driven. Visual polish must not add offside, no-goal, replay-only, or celebration-only moments as counted goals.
- Each selected goal segment must preserve phase timing fields: `buildupStart`, `shotStart`, `finishTime`, `confirmationTime`, `sourceStart`, and `sourceEnd`.
- Replay material can support confirmation, but `replayOnly` must stay false for primary goal segments.
- Transition metadata must describe how goals are connected: transition type, duration, continuity, previous cut reason, and next cut reason.
- Captions should be aligned to the phase they describe. Goal claims should happen only after finish or confirmation evidence.
- Visual polish QA must be reportable in eval and live proof outputs without exposing secrets, raw provider errors, absolute paths, or storage keys.

## Added Signals

- `editAssembly`: stable segment-level assembly metadata for chronological goal sequences.
- `visualPolishQA`: reportable QA summary with counted-goal coverage, replay-only risk, abrupt cut risk, caption alignment, average segment duration, and a visual polish score.
- `buildupStart`: normalized segment timing field used to verify that the generated clip starts before the finish/payoff instead of starting on replay or celebration.

## Gates

- `countedGoalRecall` must remain 1 for valid-goals-only fixtures.
- `falseGoalRate` must remain 0.
- `replayOnlyGoalRate` must remain 0.
- `abruptCutRiskCount` must be 0.
- `visualPolishScore` should stay above the reference-style threshold in eval.

## Limitations

- This layer adds deterministic QA contracts and reportable polish metrics. It does not yet guarantee pixel-perfect cinematic similarity with a reference creator's edit.
- Subtle zoom, animated text, and deeper visual rhythm matching still need a later render/style milestone.
- Live proof MP4s and report JSON files are generated artifacts and should not be committed.
