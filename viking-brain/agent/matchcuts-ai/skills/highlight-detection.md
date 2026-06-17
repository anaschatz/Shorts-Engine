# Skill: Highlight Detection And Edit Plans

Use when improving football moment selection, retention ranking, candidate shorts or AI edit-plan generation.

Workflow:

1. Extract or mock media signals with `server/analysis.cjs`.
2. Normalize transcript captions/segments.
3. Score candidate moments by football phrases, audio peaks, scene changes, replay markers, crowd reaction, tactical build-up and safe visual signal windows.
4. Return 2-3 candidate moments with start/end, reason codes, confidence and retention score.
5. Convert candidates through `server/football-story-planner.cjs` into validated 9:16 or 1:1 MP4 edit plans.
6. Render only the top candidate in the MVP.

Guardrails:

- Never render unvalidated AI output.
- Keep fallback deterministic and visibly marked as fallback in analysis metadata.
- Keep provider/internal errors out of API responses.
- Preserve tests for ranking and candidate plan validation.
- Visual signals are contextual evidence only. They may support saves, fouls, shots, counters and unknown action, but must never imply a goal without explicit `goal` reason evidence.
- Sampled frames may improve visual context, but the local adapter is conservative: no brittle object tracking, no false goal inference and no public path leakage.
- Provider-backed vision labels must be schema-validated. Runtime provider failures may fall back safely, but malformed semantic output such as visual-only `goal` labels must fail closed.
- Story planning must keep captions tied to the classified moment type and must strip title/context goal language when there is no explicit goal evidence.
- Story captions should use the validated sequence `opening_hook`, `context`, `action_callout`, `reaction`, `closing_punch` so the renderer can apply kinetic captions predictably.
- Title-derived context should prefer matchup/team segments over generic competition labels when pipe-separated titles are available.
- Evidence-specific context should win over title context for action-heavy moments such as chances, saves, fouls, counters, replays and scoreboard-only unknown action, because the caption role must describe the actual phase.
- Weak skill words such as “touch” or “turn” are not enough to classify a scoreboard-only visual window as a skill move; keep those cases neutral unless there is stronger skill or action evidence.
- Reference-style review should be run after highlight/caption changes with `npm run eval:reference`; it checks expected vs actual moment type, caption/action alignment, false goal claims, framing and animation relevance.
- Ranking explanations should stay safe and bounded: expose action boost cues, supporting visual/audio cues, reaction-only penalties and rejected goal claims, but never raw provider errors, logs or local paths.
- Action-led evidence should outrank crowd-only reaction when clear shot/save/foul/counter evidence exists. Crowd reaction can support an action, but should not become the primary moment unless it is the strongest available evidence.
- Candidate captions must include `captionIntent`, `captionSource`, `captionEvidence` and `captionRiskFlags` after edit-plan validation. Missing metadata is an eval regression.
- Run `npm run eval` after ranking/caption changes; it now checks caption evidence metadata, caption/action alignment and generic hype penalties.
