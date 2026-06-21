# Score-Change Anchored Goal Action Fusion

## Purpose

ShortsEngine uses stable scoreboard OCR score changes as truth anchors, but a score change alone must never create a goal claim. A counted goal segment is renderable only when the score change can be fused with live action evidence and safe finish/confirmation support.

## Current Contract

- Stable OCR score increases create internal score-change anchors with safe fields such as `scoreBefore`, `scoreAfter`, `changeTime`, `actionAnchorTime`, `scoringSide`, `confidence`, and `cannotConfirmGoalAlone`.
- Pending score increases that later stabilize are used as `actionAnchorTime`, not as separate counted score changes.
- Local OCR without strong QA/decoder support can confirm a goal only when a pending score increase later stabilizes or explicit finish evidence exists.
- OCR-only, replay-only, celebration-only, and action-without-finish cases fail closed.

## Renderable Goal Requirements

A selected counted-goal segment must have:

- `outcome: confirmed_goal`
- stable score increase with no revert/no-goal context
- live action or shot support
- finish support from explicit ball-in-net, strong calibrated/decoder OCR, or pending-to-stable score confirmation
- `replayOnly: false`
- phase coverage for buildup, shot, finish, and confirmation

## Live Proof

The YouTube proof for `gxiRyFZXJV8` produced a new MP4 with:

- `countedGoalsFound: 3`
- `countedGoalsIncluded: 3`
- `expectedCountedGoals: 3`
- `replayOnlySegments: 0`
- ffprobe passed: 1080x1920 H.264 with audio, 88.5 seconds

Generated reports and MP4 files remain generated artifacts and should not be committed.
