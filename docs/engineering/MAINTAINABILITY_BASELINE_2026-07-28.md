# Maintainability baseline — 2026-07-28

This report freezes the pre-refactor state for the maintainability-only phase. It
is intentionally separate from product, provider, video-quality, and
infrastructure work.

## Repository and verification

- Branch: `codex/production-beta-vertical-slice`
- Commit: `fe18b419f3ef676fd0c2cf0560245e92e02a8e14`
- Upstream: same commit; working tree was clean before verification.
- Runtime: Node `22.23.0`; CPython `3.13` in an isolated temporary environment.
- `npm run lint`: pass.
- `npm run build`: pass.
- `npm test`: 1,631 pass, 7 skip, 2 subprocess timeouts while the Python suite
  ran concurrently. The three affected test files passed serially, 18/18, in
  0.42 seconds; the failures are baseline resource-contention flakiness rather
  than deterministic failures.
- `python -m unittest discover -s tests`: 496/496 pass.
- `scripts/run_python_tests_isolated.py`: 52/52 modules pass.
- `research/eval.py`: quality `96.2981`, hard guardrails pass.
- PostgreSQL/S3 integration tests were skipped because their opt-in credentials
  were not configured. Docker/Podman is not available on this machine.

## Production-code inventory

The measured boundary is tracked `server` JavaScript plus
`shorts_generator`/root Python, excluding tests and duplicate files whose names
end in ` 2` or ` 3`: 277 files and 128,752 physical lines.

| Rank | File | Lines | Functions | Classes | Imports |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | `shorts_generator/local/clipper.py` | 7,658 | 153 | 3 | 30 |
| 2 | `server/render-job.cjs` | 5,927 | 305 | 0 | 23 |
| 3 | `server/analysis.cjs` | 5,848 | 295 | 0 | 12 |
| 4 | `server/app.cjs` | 2,974 | 206 | 0 | 65 |
| 5 | `shorts_generator/highlights.py` | 2,834 | 59 | 1 | 15 |
| 6 | `server/scoreboard-ocr.cjs` | 2,594 | 135 | 0 | 9 |
| 7 | `server/pipelines/narrated-short/animation/motion-calibration-corpus.cjs` | 2,581 | 135 | 0 | 8 |
| 8 | `server/match-event-truth.cjs` | 2,550 | 136 | 0 | 6 |
| 9 | `server/jobs.cjs` | 2,094 | 132 | 0 | 12 |
| 10 | `server/adapters/sqlite-persistence-adapter.cjs` | 1,849 | 81 | 0 | 10 |
| 11 | `server/edit-plan.cjs` | 1,836 | 102 | 0 | 7 |
| 12 | `server/rendered-goal-proof.cjs` | 1,732 | 98 | 0 | 10 |
| 13 | `server/render.cjs` | 1,693 | 78 | 0 | 18 |
| 14 | `shorts_generator/ranker.py` | 1,414 | 35 | 0 | 10 |
| 15 | `server/adapters/postgres-persistence-adapter.cjs` | 1,403 | 61 | 0 | 22 |
| 16 | `shorts_generator/pipeline.py` | 1,397 | 30 | 0 | 28 |
| 17 | `server/queue/postgres-job-queue.cjs` | 1,379 | 56 | 0 | 7 |
| 18 | `server/goal-evidence-provider.cjs` | 1,296 | 64 | 0 | 7 |
| 19 | `server/video-output-gate.cjs` | 1,180 | 59 | 0 | 9 |
| 20 | `shorts_generator/growth_replay.py` | 1,045 | 25 | 1 | 13 |
| 21 | `shorts_generator/hook_gate_v3.py` | 1,037 | 27 | 0 | 14 |
| 22 | `server/adapters/s3-artifact-adapter.cjs` | 1,021 | 54 | 0 | 9 |
| 23 | `server/pipelines/football/review/postgres-review-repository.cjs` | 997 | 45 | 0 | 13 |
| 24 | `shorts_generator/production_workflow.py` | 991 | 21 | 2 | 20 |
| 25 | `server/visual-tracking.cjs` | 977 | 50 | 0 | 12 |
| 26 | `server/pipelines/narrated-short/animation/semantic-event-graph.cjs` | 953 | 52 | 0 | 16 |
| 27 | `server/pipelines/narrated-short/animation/semantic-geometry-blueprint.cjs` | 932 | 47 | 0 | 18 |
| 28 | `server/football-story-planner.cjs` | 880 | 42 | 0 | 8 |
| 29 | `shorts_generator/artifact_contracts.py` | 876 | 26 | 3 | 9 |
| 30 | `server/pipelines/narrated-short/animation/semantic-visual-sentence-planner.cjs` | 873 | 46 | 0 | 18 |

## Coupling and risk map

The Python package has 47 modules, 84 internal import edges, and no static import
cycles. The Node server has 231 modules, 935 internal edges, and eight existing
cycle groups/representations. They are concentrated in tracking-provider
adapters, animation contract/planner modules, and the TTS/pilot operator-tool
boundary. This phase must not add cycles.

`clipper.py` is the first boundary because it combines unrelated responsibilities:
FFmpeg command planning, process execution, crop/reframe policy, captions,
Real-ESRGAN integration, filesystem caches, audio filters, and batch
orchestration. Its largest functions are `_reframe_vertical` (1,157 lines),
`crop_highlights_local` (773), `_CaptionRenderer` (596), and
`_bf_editorial_tail_plan` (363).

Import-time state includes environment-derived cache limits/directories,
Real-ESRGAN batch settings, visual-analysis and lossless-cut cache settings, and
a process lock. Real-ESRGAN and lossless-cut cache pruning duplicate the same
filesystem-size/LRU/90%-target algorithm. This is the first extraction seam:
one explicit bounded-file-cache helper, while `clipper.py` remains the
compatibility facade.

Existing callers and tests patch private facade names, including
`crop_clip_local`, `_run_realesrgan_process`, `_probe_video_frame_size`,
`_resolve_realesrgan_runtime`, `_realesrgan_runtime_fingerprint`,
`_get_or_create_lossless_cut`, and `_cut_subclip`. Tests also import
`_build_word_cues`, `_composite_encode_command`, and `_raw_video_command`.
Those names and their patch behavior are compatibility contracts for this phase.

## First slice and non-goals

The first slice will add characterization tests for cache keys, exact cut-command
arguments, LRU pruning, and facade patch points. It will then extract only the
duplicated bounded filesystem-cache policy from `clipper.py`. It will not change:

- FFmpeg arguments, timestamps, crop coordinates, caption layout, encoding, or
  rendered bytes;
- public CLI/API schemas, defaults, environment variables, logs, or artifact
  paths;
- provider selection, model behavior, product features, or deployment;
- ranking, HookGate, or editorial decisions.

The slice budget is one new production module, one large production module
touched, fewer production lines added than removed, and a net non-positive
production-LOC delta.
