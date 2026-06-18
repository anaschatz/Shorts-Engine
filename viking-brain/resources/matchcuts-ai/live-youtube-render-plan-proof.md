# Live YouTube Render Plan Proof

## Decision

Live YouTube proof must prove the selected edit plan, not only that an MP4 was downloaded.

`youtube:proof:operator` now requires completed jobs to expose a safe public render plan summary before the proof can pass. For long YouTube sources, the proof fails closed unless the selected render plan is a multi-moment compilation.

## What The Report Shows

`demo/results/youtube-live-e2e-latest.json` includes:

- generated artifact relative ref and sha256 prefix
- render mode
- segment count
- source timestamps per segment
- captions and roles
- animation cue types
- framing and crop mode
- top candidate summaries

The report must not include raw URLs, absolute local paths, storage keys, raw provider errors, logs, artifacts or tokens.

## Current Live Proof

For video `gxiRyFZXJV8`, the latest accepted proof produced:

- artifact: `manual-downloads/shortsengine-youtube-gxiRyFZXJV8-2026-06-18T15-41-24-080Z.mp4`
- sha256 prefix: `83dbf369f4f53ad4`
- mode: `multi_moment_compilation`
- segments: 3
- total duration: 48 seconds
- source windows: `18.84-30.84`, `49.74-67.74`, `79.45-97.45`

Older manual-download MP4s for the same source were deleted so UI/browser review does not show stale output.

## Safety Notes

- Weak opening windows in long sources are excluded unless they have strong football action evidence.
- Multi-moment compilation can render up to 90 seconds, while single-moment windows remain capped at 60 seconds.
- Non-replay segments cannot overlap; selection follows the validator's overlap rules.
- No false goal claims are allowed without explicit goal/outcome evidence.
