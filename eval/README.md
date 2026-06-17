# MatchCuts AI Evaluation Dataset

This folder contains the local quality loop for the Real AI Analysis Layer.

## Run

```bash
npm run eval
npm run eval:reference
```

The runner is deterministic and does not require API keys or network access. It loads JSON fixtures from `eval/fixtures/`, runs them through `server/analysis.cjs`, validates candidate edit plans, and writes reports to `eval/results/`.

`npm run eval:reference` runs the reference-style review fixtures in `eval/reference-fixtures/`. It compares expected vs actual moment type, caption roles, caption/action alignment, animation cue relevance, framing safety, aspect ratio, hook strength and false goal claims. It writes `eval/results/reference-latest.json` plus a timestamped `reference-review-*.json` report.

## Metrics

- `top1Overlap`: how much the top-ranked moment overlaps the expected highlight window.
- `top3Recall`: expected highlight windows covered by the top three moments.
- `reasonCodePrecision`: how cleanly predicted reason codes match expected labels.
- `reasonCodeRecall`: how many expected reason codes were recovered.
- `visualReasonPrecision`: how cleanly visual reason codes match visual expected labels.
- `falseVisualGoalRate`: guardrail for visual signals accidentally becoming goal claims.
- `retentionScore`: sanity check for the selected moment.
- `candidatePlanValidity`: validated 9:16 MP4 candidate plans.
- `captionTimingValidity`: captions remain inside the selected source window.
- `fallbackUsageRate`: how often deterministic fallback was used.
- `visualFallbackUsageRate`: how often visual analysis used the safe heuristic fallback.

Reference review additionally reports:

- `momentRelevance`: top moment type, overlap and reason-code fit.
- `noFalseGoalClaim`: hard guardrail for no-goal fixtures.
- `captionActionAlignment`: whether captions match the detected football moment.
- `captionRoleSequence`: validated short-form story arc.
- `animationCueRelevance`: whether kinetic/beat cues match the evidence.
- `framingSafety` and `aspectRatioCorrectness`: safe vertical/square output expectations.
- `hookStrength` and `replayOutroUsefulness`: reference-style opening and closing structure.

## Fixture Schema

Each fixture includes:

- `id`, `title`, `language`, `durationSeconds`
- `transcript.captions`
- `mediaSignals`
- optional `visualSignals` with bounded windows and safe reason-code evidence
- `expected.highlights`
- `expected.reasonCodes`
- `expected.stylePreset`
- `thresholds`

Reference fixtures include:

- `expected.highlightType`
- `expected.captionRoles`
- `expected.captionMustMentionAny`
- `expected.forbiddenClaims`
- `expected.requiredAnimationCues`
- `expected.aspectRatio`
- `expected.safeFraming`
- `expected.minQualityScore`

Reports must not include secrets, raw provider errors, or local absolute paths.
