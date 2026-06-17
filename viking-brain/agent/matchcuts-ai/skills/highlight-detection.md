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
