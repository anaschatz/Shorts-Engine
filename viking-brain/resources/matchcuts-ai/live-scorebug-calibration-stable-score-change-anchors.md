# Live Scorebug Calibration: Stable Score Change Anchors

Updated: 2026-07-02

## Purpose

Use stable scorebug OCR changes as explicit counted-goal anchors for live YouTube proof. The anchor contract makes the system explain whether a score change was stable, reverted, linked to visible live action, or missing visual support before any MP4 can be treated as proof.

## Contract

Each score change anchor should expose only safe bounded fields:

- `scoreBefore` and `scoreAfter`
- `firstSeenAt`, `confirmedAt`, `stableUntil`
- `reverted` and `revertedAt`
- `source`, `roiId`, `layoutId`
- `linkedEventId` and `linkedEventType`
- `selectedForRender`
- `hasLiveAction`, `hasVisibleFinish`, `replayOnly`
- `missingEvidence`
- `evidenceCodes`

Do not expose raw OCR text, provider stderr/stdout, absolute paths, storage keys, cookies or tokens.

## Selection Rules

- Stable score increases can become counted-goal anchors only when linked to visible live action and visible finish evidence.
- Reverted score changes must be treated as disallowed/no-goal context.
- Scoreboard-only changes without visual goal phase support stay out of render selection.
- Replay-only and celebration-only windows can support context but must not become the main goal segment.

## Validation

Keep tests around:

- stable scorebug increase selected only with live action
- delayed score change linking back to earlier live phase
- scoreboard-only finish rejection
- reverted score change rejection
- safe YouTube proof output fields

Run focused checks before full release validation:

```bash
node --test --test-concurrency=1 --test-timeout=120000 tests/match-event-truth.test.cjs tests/youtube-runtime.test.mjs
node --test --test-concurrency=1 --test-timeout=120000 tests/render-job.test.cjs tests/goal-evidence-provider.test.cjs tests/scoreboard-ocr.test.cjs
```
