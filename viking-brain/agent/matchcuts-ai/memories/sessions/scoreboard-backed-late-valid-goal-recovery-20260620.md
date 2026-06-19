# Session: Scoreboard-Backed Late Valid Goal Recovery

## Decisions

- Added conservative scoreboard-backed goal recovery for late goals missed by ball-in-net visual detection.
- Required strong usable OCR QA plus nearby shot/trajectory evidence before recovery.
- Kept OCR-only score changes fail-closed and blocked recovery when offside/no-goal evidence is nearby.
- Allowed Match Event Truth and valid-goals-only planning to accept `scoreboard_backed_goal_sequence` without pretending there was ball-in-net evidence.
- Added smooth transition metadata for multi-goal compilations to reduce abrupt cuts.

## Checks Added

- Goal evidence provider test for recovered scoreboard-backed goals.
- Goal evidence provider test for OCR-only score change remaining non-goal.
- Match Event Truth test for scoreboard-backed confirmed goals.
- Analysis test for all confirmed goals, offside exclusion, chronological order and smooth transitions.
- Eval fixture for a late scoreboard-backed valid goal.

## Focused Validation

- `node --test tests/goal-evidence-provider.test.cjs tests/match-event-truth.test.cjs tests/analysis.test.cjs tests/eval.test.cjs` passed with 75/75 tests.

## Limitations

- The recovery still depends on upstream OCR QA quality and shot evidence recall.
- It does not solve all provider-backed tracking or real OCR extraction gaps; it only prevents missing late valid goals when safe supporting evidence exists.
