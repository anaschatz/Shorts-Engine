# Human-Visible Goal Gate + Real Sequence Proof - 2026-06-22

## Decisions

- Added a dedicated human-visible goal gate instead of letting counted-goal metadata alone pass release proof.
- Kept cut-smoothness QA separate from human-visible goal validation.
- Exposed `visualGoalGate`, `humanVisibleGoalsIncluded`, `humanVisibleGoalRecall`, and `failedVisibleGoalSegments` in safe demo/live proof reports.
- Added eval scoring for fixtures that opt into `humanVisibleGoalGateRequired`.

## Verification

- Focused tests passed for the gate, analysis, YouTube runtime proof behavior, and eval scoring.
- Live proof should now fail clearly when a generated video claims expected counted goals but does not show each as a visible buildup/shot/finish/confirmation sequence.

## Limitation

- This milestone blocks false proof. It does not yet guarantee the model will reconstruct every missing visible goal phase from the source; that remains the next product milestone.
