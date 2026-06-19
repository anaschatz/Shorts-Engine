# Session: Truth-Driven Valid Goals Only Short Builder

## Decisions

- Switched valid-goals-only planning from candidate-moment filtering to Match Event Truth as the primary selector.
- Added deterministic truth-driven goal moments with confirmed-goal-only eligibility.
- Preserved truth-selected source windows through story planning so decision context and late goals are not trimmed away.
- Added fail-closed behavior when valid-goals-only mode has no match-event truth input or no confirmed goals.
- Added eval metrics for clean valid-goals-only coverage, no-goal exclusion, filler rate and cut smoothness.

## Checks Added

- Analysis tests cover truth-driven valid-goals-only selection, late goals, no-filler behavior and missing-truth fail-closed behavior.
- Render job tests assert `matchEventTruth` is passed into edit-plan creation.
- Eval tests assert the new valid-goals-only metrics stay green.
- Static lint asserts the internal truth-driven selector and timing constants exist.

## Limitations

- The selector still depends on upstream truth recall. Provider-backed truth can improve detection later, but the planner no longer invents valid goals without confirmed truth.
