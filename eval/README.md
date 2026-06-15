# MatchCuts AI Evaluation Dataset

This folder contains the local quality loop for the Real AI Analysis Layer.

## Run

```bash
npm run eval
```

The runner is deterministic and does not require API keys or network access. It loads JSON fixtures from `eval/fixtures/`, runs them through `server/analysis.cjs`, validates candidate edit plans, and writes reports to `eval/results/`.

## Metrics

- `top1Overlap`: how much the top-ranked moment overlaps the expected highlight window.
- `top3Recall`: expected highlight windows covered by the top three moments.
- `reasonCodePrecision`: how cleanly predicted reason codes match expected labels.
- `reasonCodeRecall`: how many expected reason codes were recovered.
- `retentionScore`: sanity check for the selected moment.
- `candidatePlanValidity`: validated 9:16 MP4 candidate plans.
- `captionTimingValidity`: captions remain inside the selected source window.
- `fallbackUsageRate`: how often deterministic fallback was used.

## Fixture Schema

Each fixture includes:

- `id`, `title`, `language`, `durationSeconds`
- `transcript.captions`
- `mediaSignals`
- `expected.highlights`
- `expected.reasonCodes`
- `expected.stylePreset`
- `thresholds`

Reports must not include secrets, raw provider errors, or local absolute paths.
