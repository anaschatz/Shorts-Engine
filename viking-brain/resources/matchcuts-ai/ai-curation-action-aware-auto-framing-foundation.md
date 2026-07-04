# AI Curation + Action-Aware Auto-Framing Foundation

## Purpose

Use this milestone when ShortsEngine needs to compete with generic clipping tools by selecting more meaningful football moments and keeping the action inside the vertical frame.

## Curation Contract

- Transcript energy is analyzed by `server/transcript-energy.cjs`.
- The analyzer is deterministic and local by default: no API keys, no network and no paid provider are required for tests, eval or demo.
- It extracts keyword hits, exclamation density, commentator intensity, possible event type, confidence and safe reasons.
- Hype-only transcript or crowd-only language is support context. It must not become a goal claim.
- Goal language is accepted only when it is explicit event language. Non-event context such as "behind the goal" or decision context such as offside/no-goal must not produce a goal reason.
- `detectHighlights` includes transcript energy in moment evidence and ranking explanation so reports can show why a moment was selected.

## Framing Contract

- Crop planning remains behind `server/visual-tracking.cjs`.
- `cropPlan` now exposes `cropMode`, `actionCenterX`, `actionCenterY`, `trackingConfidence`, `maxPanSpeed` and `safeMargins` for proof/reporting.
- `soft_follow` is allowed only with high-confidence ball/player/action evidence and contained action bounds.
- Low-confidence, camera-motion-heavy or caption-obstructed scenarios fall back to wide-safe framing.
- Tracking metadata must never imply a goal. `goalClaimAllowed` stays false for tracking.

## Evaluation

- Fixtures `037_transcript_energy_save_no_goal.json` and `038_action_edge_soft_follow_tracking.json` cover high-energy save curation and reliable edge-action soft follow.
- Useful metrics include high-energy moment recall, false goal from hype rate, crop safety, ball/player visibility, wide-safe fallback correctness and tracking confidence calibration.

## Safety

- No raw provider output, local paths, secrets, tokens or storage keys in public output.
- No brittle OpenCV dependency is required. Optional external tracking can be added behind adapters, but deterministic fallback remains default.
- When evidence is uncertain, prefer neutral moment typing and wide-safe framing.
