# Post-Fetch Valid Goal Evidence Planning Gate

## Decision

ShortsEngine must not return a generic `NO_VALID_GOALS_FOUND` after a successful YouTube fetch. The render pipeline now attaches a safe planning diagnostics contract to valid-goals-only failures so the operator can see whether the source was ready, whether OCR ran, how many score changes were found, how many candidates were rejected, and which evidence was missing.

## Safety Contract

- Keep source fetch, OCR, candidate selection, edit planning, and output QA as separate boundaries.
- Do not promote random chances, crowd-only spikes, replay-only clips, celebrations, hymns, or weak visual context into counted goals.
- Preserve fail-closed behavior when no counted-goal evidence exists.
- Store only safe counts, reason codes, and bounded candidate summaries in job errors and live proof reports.
- Never include local paths, storage keys, raw OCR text, raw provider output, cookies, tokens, stdout, or stderr.

## Runtime Contract

When valid-goals-only planning cannot create a candidate plan, the failure details include:

- `phase`, `step`, `substep`
- source readiness booleans
- OCR provider/chunk summary counts
- score-change counts
- candidate and rejected-candidate counts
- top rejection reasons
- bounded candidate summaries
- match-event truth counts
- `nextAction`

The live YouTube proof can use either server event diagnostics or failed job error details, so reports remain actionable even when server event capture is incomplete.

## Limitation

This milestone improves proof and planning diagnostics. It does not claim goals when OCR/vision evidence is absent. For the current long YouTube source, if OCR still returns `0` score changes and only rejected `non_goal_chance` candidates, the correct result is still a clean failure with evidence guidance, not a misleading MP4.
