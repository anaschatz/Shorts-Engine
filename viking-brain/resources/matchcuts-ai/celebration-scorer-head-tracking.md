# Celebration Scorer Head Tracking

## Purpose

After the live finish, football broadcasts often cut from the ball to a running player, group celebration, or crowd shot. ShortsEngine must hand framing from ball tracking to a foreground player target without treating crowd colors or advertising as a head.

## Contract

- Goal truth remains scoreboard and visible-action based. Head tracking never enables a goal claim.
- The local FFmpeg tracker requests a small bounded set of goal-specific post-finish frames.
- On macOS, the optional Apple Vision adapter detects faces first and falls back to a prominent human rectangle when only a side profile is visible.
- The first reliable post-finish player locks the target for that goal. A large discontinuity is treated as a camera cut and rejected instead of following a fan or a different subject.
- If no clear player exists, tracking falls back safely; skin-color regions are not accepted as production head evidence.
- Render QA counts only validated Vision face/person keyframes and requires coverage for every goal in strict multi-goal proof mode.

## Proof

- Authorized source: `WuuGus5Obkg`.
- Fresh MP4: five counted goals and five celebration-tracked goals.
- Render summary: six validated celebration keyframes, 25 total crop keyframes, max pan speed `0.18`.
- Human before/after contact-sheet review showed the scorer or foreground celebration group retained in frame for all five goals. The largest gains were goals 1 and 2, which previously drifted to empty sideline/crowd regions.

## Limits

- The adapter does not perform player identity recognition; it follows the prominent goal-bound foreground player with temporal continuity.
- Source-camera occlusion cannot be removed. The engine must reject abrupt target switches and hold/fallback safely.
- Apple Vision is optional and platform-specific. Tests use injected deterministic output, and unsupported environments remain fail-closed.
