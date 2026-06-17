# Session Memory: goal-evidence-sequence-detection-20260618

## Decisions

- Added explicit goal-sequence evidence composition for ShortsEngine.
- Goal claims now require a strong sequence instead of goal-area, crowd or
  reaction context alone.
- Visual cues for shot/contact, ball trajectory, goal mouth, keeper action,
  ball in net and celebration-after-shot are allowed as validated evidence.
- Medium or weak visual goal evidence can stretch an action-first story window,
  but it remains a chance/save/reaction and cannot produce goal captions.
- Story windows for goal sequences prefer build-up, shot/contact, trajectory,
  payoff and reaction support. Strong/medium sequences can use 12-22 second
  windows.

## Implementation Notes

- `server/vision.cjs` owns the new visual types and reason codes.
- `server/analysis.cjs` builds safe `goalEvidence` metadata and rejects goal
  claims without strong evidence.
- `server/football-story-planner.cjs` expands action-first source windows for
  goal-sequence evidence.
- `server/caption-generation.cjs` treats the new visual goal-sequence reasons as
  action evidence.
- `eval/scoring.cjs` reports goal-sequence recall, shot-to-payoff coverage,
  action-window coverage, ball/player visibility and reference-style similarity.

## Validation Snapshot

- Focused tests passed for analysis, vision and caption generation.
- `npm run eval` passed with aggregate score `98` across `19` fixtures.
- `npm run eval:reference` passed with aggregate score `99` across `9`
  reference fixtures.

## Limitations

- The local implementation is still conservative and provider-label-driven. It
  does not claim object tracking or infer goals from visual noise.
- Live YouTube comparison remains operator-controlled and depends on authorized
  ingest plus local downloader readiness.
