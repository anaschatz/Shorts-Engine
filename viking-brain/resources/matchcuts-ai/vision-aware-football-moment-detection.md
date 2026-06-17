# Vision-Aware Football Moment Detection Foundation

## Contract

ShortsEngine now has a dedicated visual analysis boundary in `server/vision.cjs`.
The adapter returns normalized visual windows with bounded types, confidence, evidence and safe reason codes.
Visual evidence is contextual only and never allows a goal claim by itself.

## Visual Signal Types

Allowed visual types:

- `ball_visible`
- `goal_area_visible`
- `penalty_box_visible`
- `shot_like_motion`
- `save_like_motion`
- `foul_like_contact`
- `fast_break_motion`
- `replay_indicator`
- `camera_pan`
- `player_cluster`
- `goal_mouth_visible`
- `shot_contact`
- `ball_toward_goal`
- `keeper_action`
- `ball_in_net`
- `celebration_after_shot`
- `unknown_visual_action`

Allowed visual reason codes:

- `visual_ball_visible`
- `visual_goal_area`
- `visual_shot_like_motion`
- `visual_save_like_motion`
- `visual_foul_like_contact`
- `visual_fast_break`
- `visual_replay_indicator`
- `visual_goal_mouth`
- `visual_shot_contact`
- `visual_ball_toward_goal`
- `visual_keeper_action`
- `visual_ball_in_net`
- `visual_celebration_after_shot`
- `visual_unknown_action`

## Pipeline Integration

`server/render-job.cjs` runs `analyze_visuals` after media analysis and before transcription/highlight detection.
The default analyzer is a safe heuristic fallback. It can mark `unknown_visual_action` from high-confidence motion windows, but it does not claim ball tracking, object tracking or goals.
`detectHighlights` accepts `visualSignals` and may rank:

- shot-like visual motion as `big_chance`
- save-like visual motion as `save`
- foul-like visual contact as `foul`
- fast-break visual motion as `counter_attack`
- goal-area-only visibility as `unknown_action`
- full goal-sequence evidence as `goal`

Full goal-sequence evidence requires a strong action chain. Goal-mouth context or
shot-like motion alone still cannot create a goal claim.

## Edit Plan Metadata

Candidate plans include:

- `visualEvidenceSummary`
- `actionFocusConfidence`
- `framingReason`

Default framing stays `wide_safe_vertical`.
Action-biased framing is rejected unless action focus is high-confidence, and the current foundation still avoids object-tracking claims.

## Evaluation Gates

New fixtures cover:

- visual shot-like phase without goal claim
- visual save-like phase without goal claim
- visual foul/contact phase without goal claim
- goal-area-only visibility without goal claim

Evaluation reports now include:

- `visualReasonPrecision`
- `visualReasonRecall`
- `falseVisualGoalRate`
- `visualFallbackUsageRate`
- `goalSequenceRecall`
- `shotToPayoffCoverage`
- `actionWindowCoverage`

Acceptance guardrail: `falseVisualGoalRate` must stay `0`.

## Limitations

This is a safe action-tracking foundation, not real ball/player tracking.
The sampled-frame milestone adds bounded frame extraction and a provider adapter contract, but local analysis remains conservative until a validated real provider is explicitly enabled.
