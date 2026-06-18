# Real Goal Evidence Layer

## Purpose

ShortsEngine now has a dedicated goal-evidence provider boundary between visual analysis/transcription and highlight selection. The goal is to classify ball-in-net sequences as confirmed, offside/no-goal, unconfirmed, or non-goal chance without allowing crowd noise, commentary excitement, celebration-only clips, or goal-area context to create false goal claims.

## Architecture

- `server/goal-evidence-provider.cjs` owns the normalized evidence contract.
- `server/render-job.cjs` runs `analyze_goal_evidence` after transcription and before highlight detection.
- The provider can add safe supplemental decision windows back into validated visual signals through `mergeGoalEvidenceIntoVisualSignals`.
- `server/analysis.cjs` includes safe goal-evidence counts in goal discovery explainability.
- `/health` exposes `goalEvidence` readiness through the deterministic provider boundary.

## Safety Rules

- Valid goals require explicit evidence such as ball-in-net plus scoreboard/referee/commentary confirmation.
- Offside/no-goal evidence wins over positive goal evidence.
- Crowd reaction and commentator excitement are support only, never primary proof.
- Shot-like motion, goal-area context, celebration, and tracking cannot create confirmed goals by themselves.
- Provider output is bounded, schema-validated, and rejected if it contains local paths, storage keys, stdout/stderr, tokens, or secrets.

## Quality Loop

- Eval now reports `goalEvidenceCoverage`.
- Valid-goals-only fixtures must keep valid goal recall and late goal recall at 1.
- Live YouTube failure reports keep only sanitized goal discovery/evidence counts.

## Known Limitation

The default provider is deterministic and local-safe. It does not perform paid/remote computer vision by default. Live YouTube videos can still fail closed with `NO_VALID_GOALS_FOUND` when sampled frames and local labels do not expose explicit ball-in-net or decision evidence.
