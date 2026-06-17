# Session Memory: Reference Wording Caption Intelligence

Date: 2026-06-17

Decisions:
- Treated replay evidence as contextual, not weak, when `replay_worthy_moment`, `replay_or_reaction`, or `visual_replay_indicator` is present.
- Preserved neutral fallback for `unknown_action`, `generic_highlight`, scoreboard-only, and uncertain visual context.
- Added commentary-language detection for explicit commentary/call evidence without promoting the clip to a goal.
- Tightened the reference review test gate from `captionActionAlignment >= 0.75` to `>= 0.90`.

Validation snapshot:
- Focused tests passed for caption generation, analysis, and reference review.
- `npm run eval:reference` passed with aggregate score 99 and `captionActionAlignment: 1`.

Limitations:
- This remains deterministic evidence-aware captioning, not semantic video understanding.
- Crowd/commentary evidence can select a crowd reaction moment, but action-specific captions still require action evidence.
