# Maintainability slice report — 2026-07-28

This phase improved two Python boundaries only. It did not attempt to solve the
repository's overall maintainability debt.

## Results

| Gate | Baseline | Final |
| --- | --- | --- |
| `npm run lint` | pass | pass |
| `npm run build` | pass | pass |
| `npm test` | 1,631 pass, 7 skip, 2 contention timeouts; affected files 18/18 serially | 1,633 pass, 7 skip, 0 fail |
| Python discovery | 496/496 | 501/501 |
| Python isolated runner | 52/52 modules | 53/53 modules |
| HookGate evaluation | 96.2981, hard guardrails pass | 96.2981, hard guardrails pass |

Docker/Podman was unavailable, so containerized PostgreSQL/S3 integration tests
were not executed. The opt-in Node integration tests remained skipped without
their external credentials.

## Measured change

The production boundary decreased from 128,752 lines in 277 files to 128,725
lines in 279 files: 78 production lines added, 105 removed, net **-27**.

| Module | Before | After | Change |
| --- | ---: | ---: | ---: |
| `shorts_generator/local/clipper.py` | 7,658 | 7,609 | -49 |
| `shorts_generator/highlights.py` | 2,834 | 2,817 | -17 |
| `shorts_generator/local/transcriber.py` | 536 | 521 | -15 |
| `shorts_generator/local/youtube_captions.py` | 451 | 438 | -13 |
| `shorts_generator/local/bounded_file_cache.py` | 0 | 39 | +39 |
| `shorts_generator/atomic_file.py` | 0 | 28 | +28 |

Two duplicated responsibilities were removed:

1. Real-ESRGAN PNG and lossless-cut MKV caches now call one explicit bounded
   cache pruning policy. Their facade functions, patterns, size limits,
   least-recently-used order, and 90% post-eviction target remain unchanged.
2. Highlight, transcript, and YouTube-caption caches now call one explicit
   atomic UTF-8 file replacement boundary. Their existing wrapper names and
   exact JSON/text serialization formats remain unchanged.

Dependency direction is now:

```text
clipper facade -> bounded_file_cache -> pathlib

highlights/transcriber/youtube_captions facades
  -> atomic_file -> filesystem primitives
```

The affected orchestration modules no longer each depend on the implementation
details of `mkstemp`, `fsync`, replacement, and temporary-file cleanup.
Both new modules are standard-library leaves, so they add no package cycle.
The Node graph was not modified and still reports its eight pre-existing cycle
representations.

## Compatibility and regression protection

Existing private-but-consumed facade entry points remain in place, including
`_prune_realesrgan_cache`, `_prune_lossless_cut_cache`,
`_atomic_write_json`, and `_atomic_write_text`. No caller migration is required
for this slice; future callers should use the facade unless they own a new
low-level cache/storage responsibility.

Added characterization coverage verifies:

- the exact FFmpeg lossless-cut argument vector;
- cache eviction order, remaining bytes, and 90% target for PNG and MKV;
- exact pretty, compact Unicode, and raw-text serialization;
- replacement of existing files;
- destination preservation and temporary-file cleanup on replacement failure.

No FFmpeg argument, timing, caption, crop, encoding, ranking, HookGate, manifest,
API, or error contract was changed. Output-sensitive Node tests, all Python
tests, and the evaluation fingerprint/score remained green. No real render was
performed for a deterministic pixel comparison, so this report does **not**
claim pixel-identical output.

## Remaining debt and next slices

The largest risks remain substantially untouched:

- `clipper.py`: `_reframe_vertical` (about 1,157 lines),
  `crop_highlights_local` (about 773), caption rendering, process execution,
  and import-time environment state.
- `highlights.py`: candidate discovery/cache policy and the large
  `get_highlights` orchestration flow.
- `ranker.py`, `pipeline.py`, and `hook_gate_v3.py`: pure policy, orchestration,
  and report/cache state still need independent characterization-first slices.
- `server/render-job.cjs` and `server/analysis.cjs`: 5,000+ line Node
  orchestration boundaries remain unchanged.
- The eight existing Node cycle representations require separate,
  behavior-preserving work.

The safest next slice is to characterize and extract pure lossless-cut command
planning from `clipper.py`, leaving subprocess execution and facade patch points
in place. Candidate discovery should be a later independent slice; Node work
should not be mixed into either.
