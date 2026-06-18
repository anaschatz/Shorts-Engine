# MatchCuts AI Evaluation Dataset

This folder contains the local quality loop for the Real AI Analysis Layer.

## Run

```bash
npm run eval
npm run eval:reference
npm run feedback:summary
npm run review:compare
npm run review:summary
```

The runner is deterministic and does not require API keys or network access. It loads JSON fixtures from `eval/fixtures/`, runs them through `server/analysis.cjs`, validates candidate edit plans, and writes reports to `eval/results/`.

`npm run eval:reference` runs the reference-style review fixtures in `eval/reference-fixtures/`. It compares expected vs actual moment type, caption roles, caption/action alignment, animation cue relevance, framing safety, aspect ratio, hook strength and false goal claims. It writes `eval/results/reference-latest.json` plus a timestamped `reference-review-*.json` report.

`npm run feedback:summary` loads local human review JSON from `eval/human-feedback/` and writes `eval/results/feedback-latest.json` plus a timestamped `feedback-summary-*.json` report. It is local-only, does not mutate training data, and rejects unsafe generated short refs.

`npm run review:compare` loads a real-video review fixture from `eval/review-fixtures/`, validates safe generated/source/reference media refs, compares generated metadata against expected moment/style/caption/framing constraints, and writes safe reports to `eval/review-results/`. It is deterministic, no-network, API-key-free, and can use a reference-style rubric fallback when no reference video is committed.

`npm run review:summary` aggregates the latest real-video review reports in `eval/review-results/` into a local summary. It does not mutate fixtures, feedback, providers or training data.

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
- `captionSpecificityScore`: captions use action-specific wording instead of generic hype.
- `reactionAsSupportScore`: crowd/audio reaction supports stronger action evidence instead of becoming the primary claim.
- `weakEvidenceNeutralityScore`: uncertain visual evidence gets neutral pressure/developing-play copy.
- `providerFallbackRate`: how often the caption provider fell back to the deterministic local generator.
- `fallbackUsageRate`: how often deterministic fallback was used.
- `visualFallbackUsageRate`: how often visual analysis used the safe heuristic fallback.
- `goalSequenceRecall`, `shotToPayoffCoverage` and `actionWindowCoverage`: whether goal/action clips include the shot/contact through payoff instead of only a reaction.
- `animationCueRelevance`: whether punch, flash and freeze cues are backed by action/contact/payoff evidence.

Reference review additionally reports:

- `momentRelevance`: top moment type, overlap and reason-code fit.
- `noFalseGoalClaim`: hard guardrail for no-goal fixtures.
- `captionActionAlignment`: whether captions match the detected football moment.
- `captionSpecificityScore`, `reactionAsSupportScore` and `weakEvidenceNeutralityScore`: evidence-aware caption quality guardrails.
- `captionRoleSequence`: validated short-form story arc.
- `animationCueRelevance`: whether kinetic/beat cues match the evidence.
- `framingSafety` and `aspectRatioCorrectness`: safe vertical/square output expectations.
- `hookStrength` and `replayOutroUsefulness`: reference-style opening and closing structure.

Real-video review comparison additionally reports:

- `momentTypeMatch`: whether the generated short selected the expected football moment type.
- `noFalseGoalClaim`: hard guardrail against unsupported goal language.
- `captionActionAlignment` and `captionSpecificity`: whether text matches the visible/action metadata.
- `framingSafety` and `aspectRatioCorrectness`: safe ball/player framing and expected output format.
- `pacingScore`: whether the selected source window fits the expected short-form range.
- `animationCueCoverage`: whether required reference-style animation cues are present.
- `referenceStyleSimilarity`: compact style-fit score from captions, framing, pacing and cues.
- `reviewerReadinessScore`: whether the sample is ready for human review or already reviewed.

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

Real-video review fixtures include:

- `media.generated`, `media.source`, and optional `media.reference`
- `expected.momentType`, `expected.aspectRatio`, `expected.durationRange`
- `expected.captionMustMentionAny`
- `expected.requiredAnimationCues`
- `expected.safety.noFalseGoalClaim`
- `generatedMetadata.selectedMoment`
- `generatedMetadata.editPlan`
- `consent.rightsConfirmed`
- optional `humanReview`

Reports must not include secrets, raw provider errors, or local absolute paths.

## Human Feedback

Human feedback files live in `eval/human-feedback/`. Use safe opaque refs such as `eval/reference/fixture-id`, not local file paths or storage keys. The summary report tracks selected moment accuracy, caption alignment, caption specificity, false claim flags and preferred caption examples.
