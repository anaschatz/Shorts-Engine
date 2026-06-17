# Football-Aware Highlight Selection + Trendy Edit Style v1

## Contract

ShortsEngine must not imply a goal unless transcript/signal evidence supports both `highlightType: "goal"` and reason code `goal`.
Audio spikes, saves, shots, fouls, crowd reactions, commentator peaks and generic pressure phases use neutral hooks and captions.
The phrase "What a finish" is not goal evidence by itself.

## Highlight Taxonomy

Canonical highlight types:

- `goal`
- `shot_on_target`
- `near_miss`
- `big_chance`
- `save`
- `foul`
- `hard_foul`
- `card_moment`
- `counter_attack`
- `skill_move`
- `crowd_reaction`
- `commentator_peak`
- `replay_or_reaction`
- `replay_worthy_moment`
- `audio_energy_spike`
- `unknown_action`
- `generic_highlight`

`server/analysis.cjs` maps deterministic transcript/media signals to reason codes and highlight types. Goal evidence uses a context-aware guard so phrases such as "behind the goal" do not create a goal event.
Signals now include evidence metadata (`goalEvidence`, nearby audio peaks, scene changes, caption evidence) and caption intent so render/debug output can explain why a moment was selected.

## Edit Plan Additions

`server/edit-plan.cjs` validates:

- `highlightType`
- `confidence`
- `framingMode`
- `cropStrategy`
- `stylePreset`
- `captionEmphasis`
- `animationCues`
- `safetyNotes`

Default generated candidate plans use `stylePreset: "social_sports_v1"` with deterministic caption emphasis and animation cues.

## Framing

Default landscape football clips use `framingMode: "wide_safe_vertical"` and `cropStrategy.type: "wide_safe_contain"`.
This preserves the full source frame over a blurred fill in the FFmpeg render path.
Do not claim ball/player tracking until a real vision/tracking layer exists.

Fallback captions are supporting beats only. The hook is rendered as the primary short-form title, so captions must not duplicate the hook text.

## Evaluation Gates

`npm run eval` includes no-goal synthetic fixtures for:

- hard foul
- save/chance
- crowd reaction
- audio spike without semantic certainty
- generic pressure

Metrics include `falseGoalCaptionRate`, `highlightTypeAccuracy`, `captionSafety`, `framingSafety`, and `animationCueValidity`.
The no-goal acceptance rule is `falseGoalCaptionRate: 0`.
The reference-style no-goal fixture `010_finish_phrase_no_goal_reference_style.json` guards against regressing from a crowd/commentary moment back into a false goal claim.

## Limitations

This is not vision AI. It is deterministic transcript/media-signal analysis plus safe style metadata.
The next quality milestone should add real action/ball/player tracking or provider-backed visual analysis behind an adapter and evaluation gate.
