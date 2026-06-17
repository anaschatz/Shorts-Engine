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

AI-driven ranking/caption follow-up:
- Moment ranking now separates primary action evidence from reaction context.
- Action-led visual cues such as `visual_shot_like_motion`, `visual_save_like_motion`, `visual_foul_like_contact` and `visual_fast_break` receive a bounded boost.
- Crowd/commentary/audio reaction still matters, but crowd-only reaction receives a bounded penalty when no action evidence exists.
- Scoreboard-only visual context remains support-only and cannot create action or goal claims.
- Ranked moments expose `rankingExplanation` with boost cues, supporting cues, reaction cues, suppressed cues and rejected claims.
- Candidate captions expose `captionIntent`, `captionSource`, `captionEvidence` and `captionRiskFlags`.
- Edit-plan validation rejects captions that contain goal language without explicit goal evidence.
- Eval now tracks `captionEvidenceMetadataCompleteness`, `captionActionAlignment` and `genericCaptionPenaltyRate`.
- Added fixture `017_action_beats_crowd_reaction_no_goal` to verify action chance evidence outranks early crowd-only reaction.

Latest eval result:
- `npm run eval`
- Fixture count: `17`
- Aggregate score: `98`
- `captionEvidenceMetadataCompleteness`: `1`
- `captionActionAlignment`: `1`
- `genericCaptionPenaltyRate`: `0`

Next use:
- Run `npm run eval:reference` after any change to captions, highlight taxonomy, visual reason codes or story planning.
- Run `npm run eval` after any ranking or edit-plan metadata change.
- Treat a drop in caption/action alignment as a product regression even when schema tests still pass.
