# Provider-Backed Vision Labeling + Football Moment Understanding

## Contract

ShortsEngine visual analysis now treats provider output as a strict contract, not trusted freeform data.
The active entry points are:

- `analyzeVision(input)`
- `analyzeFrames(input)`
- `createVisionProvider({ mode, client, frames })`

Supported provider modes:

- `safe-heuristic`
- `frame-inspection-local`
- `mock-vision-provider`
- `external-vision-adapter`

Default local/demo/test behavior does not require API keys or network calls.
External vision is opt-in through an injected client.

## Labels

Allowed visual labels:

- `ball_visible`
- `player_cluster`
- `goal_area_visible`
- `penalty_box_visible`
- `shot_like_motion`
- `save_like_motion`
- `foul_like_contact`
- `fast_break_motion`
- `replay_indicator`
- `crowd_reaction`
- `camera_pan`
- `scoreboard_context`
- `unknown_visual_action`

Disallowed visual labels:

- `goal`
- `scored`
- `goal_scored`

Provider output containing a disallowed goal label or unknown label must fail closed with `AI_OUTPUT_INVALID`.
Runtime provider failures and timeouts may fall back to `safe-heuristic`, but malformed semantic output should not be silently accepted.

## Safety Rules

- Never create `highlightType: "goal"` from visual evidence alone.
- Goal-area visibility, scoreboard context, sampled frames, shot motion and crowd noise are context only.
- `crowd_reaction` plus audio can rank as `crowd_reaction`, not goal.
- `scoreboard_context` remains unknown/context unless explicit transcript evidence exists.
- Public output may include labels, reason codes and safe metadata, but never local frame paths, raw provider errors, API keys or storage keys.

## Caption Alignment

For visual-only moments, generic transcript captions should be replaced by highlight-type fallback copy when the transcript text does not match the moment type.
This keeps save/foul/chance/counter/reaction/replay shorts from showing misleading or irrelevant text.

## Evaluation

Eval reports track:

- `visualLabelPrecision`
- `visualLabelRecall`
- `visualFallbackUsageRate`
- `frameExtractionFallbackUsageRate`
- `falseVisualGoalRate`

Current guardrail: `falseVisualGoalRate` must stay `0`.
