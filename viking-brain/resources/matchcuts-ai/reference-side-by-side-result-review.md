# Reference Side-by-Side Result Review

## Purpose

ShortsEngine now has an opt-in local comparison runner for reviewing a generated short against a reference short without pretending that metadata proves creative quality.

## Command

```bash
npm run demo:compare
```

Default local inputs:

- Generated result: `manual-downloads/shortsengine-gxiRyFZXJV8-result.mp4`
- Reference short: `manual-downloads/shortsengine-youtube-short.mp4`

Custom inputs can be passed as safe workspace-relative `.mp4` references:

```bash
npm run demo:compare -- --generated=manual-downloads/result.mp4 --reference=manual-downloads/reference.mp4
```

## Output

The runner writes ignored local reports:

- `demo/results/side-by-side-latest.json`
- `demo/results/side-by-side-<timestamp>.json`
- optional contact sheets under `demo/results/side-by-side-artifacts/`

Reports include only safe relative references. They must not include absolute local paths, raw logs, provider output, storage keys, tokens or external artifacts.

## Metrics

The machine score covers structural checks only:

- generated/reference readability
- vertical short-form aspect ratio fit
- duration fit
- resolution fit
- contact sheet availability

The report intentionally marks the following as `needs_human_review`:

- moment selection quality
- caption/action alignment
- ball/player framing
- trendy editing style
- false-goal claim guard

## Decision

This is not a release gate because the reference videos live in `manual-downloads/` and are local operator assets. Keep it opt-in until stable fixture videos can be committed or generated deterministically.
