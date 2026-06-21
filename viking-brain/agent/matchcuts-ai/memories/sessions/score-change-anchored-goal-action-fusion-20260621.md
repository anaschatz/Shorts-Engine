# Score-Change Anchored Goal Action Fusion - 2026-06-21

## Decisions

- Added score-change action anchoring so pending OCR score increases can point the goal search back to the live phase while stable score changes remain the counted-goal truth proof.
- Preserved truth-driven confirmed goal outcomes for `match_event_truth_valid_goals_only` so candidate edit plans do not downgrade scoreboard-backed truth goals to unknown decisions.
- Kept the no-false-goal guard: local OCR plus motion/action is not enough without finish support, pending-to-stable confirmation, or strong OCR authority.

## Verification

- Focused tests passed for analysis, goal evidence, and match-event truth.
- `npm run eval` passed with aggregate score 98 and `matchEventTruthFalseGoalRate: 0`.
- Live YouTube proof for `https://www.youtube.com/watch?v=gxiRyFZXJV8` passed with 3/3 counted goals included and no replay-only segments.

## Limitations

- The live proof verifies counted-goal coverage and ffprobe output, but visual quality still needs human review against the reference style.
- Generated reports, OCR QA crops, and manual-download MP4s are intentionally excluded from commits.
