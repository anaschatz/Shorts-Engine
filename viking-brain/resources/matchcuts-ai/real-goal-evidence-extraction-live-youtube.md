# Real Goal Evidence Extraction for Live YouTube

## Decision

Live YouTube valid-goals mode must not promote shot-like clips into goals unless there is enough goal evidence. The pipeline now keeps visual support codes, exposes candidate-level diagnostics, and enables candidate-cluster recovery only for long YouTube sources running in `valid_goals_only` mode.

## Contract

- Preserve provider evidence such as shot contact, ball trajectory, goalmouth context, crowd reaction, and replay support.
- Add safe candidate diagnostics: `missingEvidence`, `recoveryEligibility`, and `rejectionReason`.
- Candidate recovery can confirm a live goal only with strong shot evidence, goalmouth or finish context, confirmation support, and no offside/no-goal disqualifier.
- Replays, crowd reaction, scorebug context, and shot-like motion remain support only when goalmouth/finish context is missing.
- Failure reports must surface actionable candidate diagnostics before log redaction truncates structured fields.

## Live Proof Result

The live proof for the current YouTube test still fails closed with `NO_VALID_GOALS_FOUND`. That is correct for this pass because detected candidates have shot support but lack goalmouth/finish context and explicit ball-in-net or decision confirmation. The report now explains this instead of returning empty candidate arrays.

## Next Work

The next blocker is stronger live visual evidence extraction: sampled-frame or OCR/vision support must detect goalmouth, ball-in-net, score changes, or referee/scoreboard confirmation on the real clip before the renderer can safely include counted goals.
