# Football Moment Quality + Action-Safe Render Framing

## Contract

- Goal claims require explicit goal evidence. Goal-area context, shot-like motion,
  crowd noise, commentary spikes and celebration alone are not enough.
- Moment ranking should prefer action sequence evidence over reaction-only
  context: build-up, shot/contact, ball trajectory, goalmouth/keeper action,
  payoff, then crowd/commentary reaction as support.
- Public/eval reports should expose safe action-sequence metadata:
  `buildUp`, `shotOrContact`, `ballTrajectory`, `goalmouthOrKeeper`,
  `payoff`, `reactionSupport`, `reactionOnly` and `primaryEvidence`.
- Render framing remains wide-safe by default when there is no reliable object
  tracking. Do not claim ball tracking or crop aggressively.
- Trend editing cues must be evidence-aligned:
  `punch_zoom` requires action evidence, while `impact_flash` and `freeze_frame`
  require contact/save/shot/payoff evidence.
- Reaction-only clips may use captions, beat cuts and replay prompts, but should
  not receive punch/impact/freeze action styling.

## Evaluation

- Keep `noFalseGoalClaim` and `falseVisualGoalRate` at safe values.
- Track `goalSequenceRecall`, `shotToPayoffCoverage`, `actionWindowCoverage`,
  `framingSafety`, `animationCueValidity` and `animationCueRelevance`.
- Eval summaries must include these metrics so regressions are visible without
  opening full fixture reports.
