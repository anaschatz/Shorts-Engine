# Real Video Review Fixtures

This folder contains local review inputs for comparing a generated short against a source video and, when available, a reference short.

Run the default review:

```bash
npm run review:compare
npm run review:summary
```

Fixtures must use workspace-relative media refs only. Do not add raw external URLs, absolute local paths, tokens, storage keys, provider logs, downloaded videos, rendered outputs, or private media to this folder.

If a reference video is not available, set `media.reference` to `null` and keep `expected.referenceStyleFallbackAllowed` enabled. The runner will score against the reference-style rubric instead of pretending a missing video was reviewed.
