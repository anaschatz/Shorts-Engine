# Goal-Evidence Sequence Detection

## Purpose

ShortsEngine now distinguishes real goal sequences from nearby reaction or
goal-area context. The product target is action-first football shorts: build-up,
shot/contact, ball trajectory, goal mouth or keeper action, payoff, then crowd or
bench reaction.

## Evidence Contract

Validated visual signal types include:

- `goal_mouth_visible`
- `shot_contact`
- `ball_toward_goal`
- `keeper_action`
- `ball_in_net`
- `celebration_after_shot`

Validated reason codes include:

- `visual_goal_mouth`
- `visual_shot_contact`
- `visual_ball_toward_goal`
- `visual_keeper_action`
- `visual_ball_in_net`
- `visual_celebration_after_shot`

The system may claim `highlightType: "goal"` only when the evidence chain is
strong. Strong evidence requires explicit goal language or a visual sequence with
shot/contact evidence, ball moving toward goal, goal-mouth context and either
ball-in-net/line-crossing evidence or celebration after the shot. Medium or weak
visual evidence can rank a chance/save/reaction, but it must not produce a goal
claim or goal caption.

## Story Planning

Goal-sequence windows are action-first and can expand to 12-22 seconds when
there is medium or strong evidence. The planner should include lead-in, shot,
trajectory and payoff, then use reaction as support. Crowd, coach or bench shots
should not outrank the action unless they are the only meaningful evidence.

## Evaluation

The main eval fixture `019_visual_goal_sequence` checks that a full visual goal
chain outranks early crowd reaction and covers shot-to-payoff timing. The
reference fixture `009_goal_sequence_reference` checks reference-style goal
story behavior.

Evaluation reports now include:

- `goalSequenceRecall`
- `shotToPayoffCoverage`
- `actionWindowCoverage`
- `ballPlayerVisibilityScore`
- `referenceStyleSimilarity`

Guardrails:

- `falseVisualGoalRate` must stay `0`.
- `falseGoalCaptionRate` must stay `0`.
- `noFalseGoalClaim` must stay `1` in reference eval.
- Provider fallback remains deterministic and should require no network or API
  keys.

## Limitations

This is not brittle computer vision or permanent ball tracking. It depends on
validated provider/fixture labels and conservative evidence composition. Real
provider labels remain behind adapters and must continue to fail closed when
unknown or unsafe values appear.
