# Reference Wording Caption Intelligence

Milestone: 2026-06-17

Purpose:
- Improve reference-style caption/action alignment for replay-heavy and high-noise commentary moments.
- Keep deterministic local behavior with no provider/API key requirement.
- Preserve the no-false-goal guard: visual shot-like motion, goal-area context, crowd noise, or replay evidence must never become a goal claim without explicit goal evidence.

Implementation notes:
- Replay indicator evidence now contributes `replay_worthy_moment` so replay-heavy clips can use timing/angle/run-it-back wording.
- Crowd/commentary context is treated as clear contextual evidence when supported by crowd/commentary reason codes, even if a weak visual reason such as `visual_unknown_action` is present.
- Caption generation now distinguishes contextual replay/crowd evidence from truly weak/unknown evidence before falling back to neutral copy.
- Reference eval scoring distinguishes replay context from reaction-only copy and does not mark clear crowd/commentary evidence as weak merely because an unknown visual label is nearby.

Quality gate:
- `npm run eval:reference` must keep `captionActionAlignment >= 0.90`; current milestone target is `1.0`.
- The reference eval must keep `noFalseGoalClaim`, `reactionAsSupportScore`, `weakEvidenceNeutralityScore`, and `providerFallbackRate` green.
