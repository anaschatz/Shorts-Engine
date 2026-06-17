# Session Memory: Caption-Action Alignment Upgrade

Date: 2026-06-17

Decisions:
- Improved the weak reference review metric by keeping evidence-specific context for action-heavy football moments.
- Preserved title-derived match context for reaction-style captions where it helps without hiding the evidence role.
- Suppressed weak `skill_move` inference from words like “touch” and “turn” when the only visual evidence is scoreboard context.
- Kept the no-false-goal contract unchanged: no `goal`/`γκολ` claim without explicit goal reason evidence.
- Cleaned Greek no-goal templates to avoid unnecessary English terms.

Files changed:
- `server/football-story-planner.cjs`
- `server/analysis.cjs`
- `tests/football-story-planner.test.cjs`
- `tests/analysis.test.cjs`
- `tests/reference-review.test.cjs`
- `viking-brain/resources/matchcuts-ai/caption-action-alignment-upgrade.md`
- `viking-brain/agent/matchcuts-ai/skills/highlight-detection.md`

Verified targeted checks:
- `node --test tests/football-story-planner.test.cjs`
- `node --test tests/analysis.test.cjs`
- `node --test tests/reference-review.test.cjs`
- `npm run eval:reference`

Verified full checks:
- `npm run lint`
- `npm run build`
- `npm test`
- `npm run eval`
- `npm run eval:reference`
- `npm run brain:health`
- `npm run ci:reports`
- `npm run release:check`
- `npm run demo:fixture`
- `npm run demo:smoke`
- `npm run demo:browser`
- `npm run demo:browser:ci`

Reference result:
- Aggregate score: `98`
- Caption/action alignment: `1`
- No false goal claim: `1`

Follow-up: AI-driven moment ranking + caption metadata
- Added primary-action vs reaction-context ranking logic so shot/save/foul/counter evidence outranks crowd-only reaction when both are present.
- Added safe `rankingExplanation` fields to moments and aggregate explainability for selected moment, selected type, boost cues and rejected goal claims.
- Added caption metadata contract through edit-plan validation:
  - `captionIntent`
  - `captionSource`
  - `captionEvidence`
  - `captionRiskFlags`
- Added deterministic eval fixture `017_action_beats_crowd_reaction_no_goal`.
- Added eval metrics:
  - `captionEvidenceMetadataCompleteness`
  - `captionActionAlignment`
  - `genericCaptionPenaltyRate`

Follow-up validation:
- Targeted tests: `node --test tests/analysis.test.cjs tests/football-story-planner.test.cjs tests/eval.test.cjs`
- Eval: `npm run eval`
- Latest eval score: `98`
- Fixture count: `17`
- Caption evidence metadata completeness: `1`
- Caption/action alignment: `1`
- Generic caption penalty rate: `0`

Limitations:
- Templates are still deterministic and evidence-label driven; they do not yet use a full semantic caption generation model.
- Vision evidence remains conservative and should not infer goals from crowd noise, shot-like motion or scoreboard context.
