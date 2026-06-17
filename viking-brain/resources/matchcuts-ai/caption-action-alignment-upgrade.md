# Caption-Action Alignment Upgrade

Milestone: Caption-Action Alignment Upgrade + Evidence-Based Text Templates.

Purpose:
- Improve caption/action alignment in the reference review while keeping no-false-goal safeguards intact.
- Make caption roles describe the actual football evidence instead of falling back to generic title context when stronger action evidence exists.
- Keep local/demo output deterministic, readable and safe for no-goal clips.

Implemented contracts:
- `server/football-story-planner.cjs` keeps the role sequence:
  - `opening_hook`
  - `context`
  - `action_callout`
  - `reaction`
  - `closing_punch`
- Evidence context is preferred for:
  - big chance / shot / near miss
  - save
  - foul / hard foul
  - counter attack
  - replay-worthy moments
  - scoreboard-only unknown action
- Title context is still allowed for matchup or reaction stories when it does not weaken the evidence-specific caption role.
- Greek no-goal copy avoids unnecessary English terms such as `keeper`, `runner`, `challenge`, `build-up` and `touch`.

Analysis guardrails:
- `server/analysis.cjs` keeps scoreboard-only visual context neutral.
- Weak skill words such as “touch” and “turn” no longer create `skill_move` when the only visual evidence is `visual_scoreboard_context`.
- Goal language still requires explicit `goal` reason evidence.
- Crowd noise, commentary spikes, scoreboard context and goal-area visuals are not goal evidence.

Reference metrics:
- Previous `npm run eval:reference` baseline:
  - aggregate score: `95`
  - `captionActionAlignment`: `0.875`
  - `noFalseGoalClaim`: `1`
- Updated milestone result:
  - aggregate score: `98`
  - `captionActionAlignment`: `1`
  - `noFalseGoalClaim`: `1`

Tests:
- Planner tests cover counter context, neutral scoreboard captions and natural Greek no-goal copy.
- Analysis tests cover scoreboard-only suppression of weak skill claims.
- Reference review tests now require `captionActionAlignment >= 0.95`.

Next use:
- Run `npm run eval:reference` after any change to captions, highlight taxonomy, visual reason codes or story planning.
- Treat a drop in caption/action alignment as a product regression even when schema tests still pass.
