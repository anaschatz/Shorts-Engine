# Football-Aware Highlight Selection + Trendy Edit Style v1

## Contract

ShortsEngine must not imply a goal unless transcript/signal evidence supports `highlightType: "goal"` or the reason codes include `goal`.
Audio spikes, saves, shots, fouls, crowd reactions and generic pressure phases use neutral hooks and captions.

## Highlight Taxonomy

Canonical highlight types:

- `goal`
- `shot_on_target`
- `big_chance`
- `save`
- `foul`
- `hard_foul`
- `card_moment`
- `counter_attack`
- `skill_move`
- `crowd_reaction`
- `replay_worthy_moment`
- `audio_energy_spike`
- `generic_highlight`

`server/analysis.cjs` maps deterministic transcript/media signals to reason codes and highlight types. Goal evidence uses a context-aware guard so phrases such as "behind the goal" do not create a goal event.

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

Default landscape football clips use `framingMode: "wide_safe"` and `cropStrategy.type: "wide_safe_contain"`.
This preserves the full source frame over a blurred fill in the FFmpeg render path.
Do not claim ball/player tracking until a real vision/tracking layer exists.

## Evaluation Gates

`npm run eval` includes no-goal synthetic fixtures for:

- hard foul
- save/chance
- crowd reaction
- audio spike without semantic certainty
- generic pressure

Metrics include `falseGoalCaptionRate`, `highlightTypeAccuracy`, `captionSafety`, `framingSafety`, and `animationCueValidity`.
The no-goal acceptance rule is `falseGoalCaptionRate: 0`.

## Limitations

This is not vision AI. It is deterministic transcript/media-signal analysis plus safe style metadata.
The next quality milestone should add real action/ball/player tracking or provider-backed visual analysis behind an adapter and evaluation gate.
