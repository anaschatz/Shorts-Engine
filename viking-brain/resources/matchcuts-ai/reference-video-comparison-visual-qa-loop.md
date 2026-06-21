# Reference Video Comparison + Visual QA Loop

ShortsEngine now has a deterministic product QA loop for comparing a generated live proof against reference-style expectations.

Command:

```bash
npm run compare:reference
```

Contract:

- Reads the latest generated proof report, defaulting to `demo/results/youtube-live-e2e-latest.json`.
- Reads metadata-only reference expectations from `eval/reference-comparison-fixtures/`.
- Writes safe JSON to `demo/results/reference-comparison-latest.json`.
- Writes a local side-by-side HTML QA artifact to `demo/results/reference-comparison-latest.html`.
- Does not download external reference videos, require API keys, mutate training data, or include raw provider output.

Metrics:

- valid goal recall
- replay-only segment count
- aspect ratio correctness
- crop safety
- full goal phase coverage
- pacing and segment duration fit
- abrupt cut smoothness
- caption/action alignment
- transition polish
- motion density
- aggregate reference similarity

Safety:

- Reference URLs must be HTTPS and cannot include secret-like query params.
- Local reference videos are optional safe relative refs, normally under ignored directories like `manual-downloads/`.
- Reports must not contain absolute paths, storage keys, tokens, raw logs, stderr/stdout, or provider errors.
- Missing proof or fixture inputs fail closed with operator recovery guidance.

Limitations:

- The default comparison is metadata-based unless an operator provides a local reference video.
- The HTML artifact is for local product QA and is not committed.
- This does not replace human taste review; it makes the known gaps measurable before human review.
