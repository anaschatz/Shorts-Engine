# Session Memory: Full-Source Valid Goal Discovery + Late Goal Coverage

Created: 2026-06-18T19:45:00Z

## Summary

- Built bounded full-source goal discovery for long football highlights so late confirmed goals are not dropped by early filler candidates.
- Valid-goals-only mode now filters edit-plan inputs to confirmed onside goals, preserves chronological multi-goal compilations, and fails closed when no valid goals are proven.
- Confirmed goal segments shift a small amount of pre-roll budget into post-decision context to avoid cutting before referee/scoreboard confirmation.
- Eval reports now include explicit valid-goal metrics: `validGoalRecall`, `lateGoalRecall`, `falseGoalRate`, `offsideExclusionAccuracy`, `validGoalOnlyFillerRate`, `captionGoalClaimAccuracy` and `segmentTimingCoverage`.
- Old dirty OpenViking memory/skill truncations were restored before adding this clean resource/session note.

## Tests Added

- Late critical visual window retention in `tests/vision.test.cjs`.
- Late candidate-window preservation in `tests/render-job.test.cjs`.
- Three late confirmed goals before early filler in `tests/analysis.test.cjs`.
- Multi-goal valid-goals-only eval fixture in `eval/fixtures/022_late_valid_goals_only.json`.
