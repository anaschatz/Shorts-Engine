# Stabilization baseline

Date: 2026-07-26
Baseline commit: `a52e022`
Branch: `codex/production-beta-vertical-slice`

This report covers the root ShortsEngine product only. Vendored repositories
such as `OpenViking`, `promptfoo`, `ruflo`, `graphify`, and
`AI-Youtube-Shorts-Generator` are not counted as root product modules.

## Runtime boundaries before stabilization

The baseline was recorded while the now-cancelled production-beta commits were
still at `HEAD`. Those entrypoints were subsequently removed by explicit
reverts before the stabilization final gates. They remain useful evidence of
the starting state, not a description of the final runtime.

| Boundary | Current owner | Main implementation |
| --- | --- | --- |
| HTTP API and human review | Node | `server/app.cjs` |
| Job orchestration | Node | `server/jobs.cjs`, `server/worker-entry.cjs` |
| Football analysis | Node | `server/analysis.cjs`, `server/match-event-truth.cjs` |
| Rendering orchestration | Node | `server/render-job.cjs`, `server/render.cjs` |
| Motivational analysis/render | Python | root `shorts_generator`, plus a separate vendored engine bridge |
| HookGate V2/V3 | Python | `shorts_generator/highlights.py`, `hook_gate_v3.py` |
| Media QA | Node and Python | Node proof modules; Python `editorial_qa.py`, `audio_qa.py` |
| Persistence interfaces | Node | local/SQLite adapters |

The motivational adapter in
`server/pipelines/motivational-source-short/python-worker-adapter.cjs` invokes
`AI-Youtube-Shorts-Generator/main.py`, not root `main.py`. Its legacy JSON
payload is hash-bound but contains absolute paths and exposes internal artifact
shapes. This is the principal contract-drift risk.

## Entrypoints

Node runtime entrypoints:

- `server/production-entry.cjs`
- `server/worker-entry.cjs`
- `server/migrate-entry.cjs`
- `server/app.cjs` (development direct entry)

Root Python/operator entrypoints:

- `main.py`
- `budget_friendly_ops.py`
- `research/eval.py`
- `research/runner.py`
- `shorts_generator/benchmark.py`
- media/provider helpers under `tools/`

## Baseline tests

| Gate | Baseline result |
| --- | --- |
| Node lint | Pass |
| Node build smoke | Pass |
| Node full suite | Fail: file-level 120s timeouts observed in four Dark Curiosity corpus/pilot/production-animation modules during this run |
| Python full suite, unprepared system Python 3.14 | 238 tests, 35 import/fixture errors |
| Python isolated modules, unprepared environment | 25/48 passed |
| HookGate offline evaluation | Pass, 7 fixtures, quality score 96.2981 |

The initial Python errors were dominated by:

- eager `dotenv`, OpenCV, NumPy, and live evaluation imports;
- `unittest.mock.patch` paths resolved through package attributes that had
  never been imported;
- publishing tests coupled to deleted generated MP4 files.

After the isolation, contract, and first modularization slices, a clean CPython
3.13 virtual environment with the locked dependency set produced:

- 496/496 Python tests passing;
- 50/50 test modules passing in separate interpreter processes;
- offline `research.runner` import without loading `research.live_eval`;
- offline `research.eval` import without loading OpenCV or NumPy.

A second clean environment containing only `requirements-core.txt` also passes
the offline evaluation, research tests, and worker-contract tests without
importing NumPy, OpenCV, or live evaluation.

## HookGate baseline

The current deterministic evaluation is a quality benchmark, not evidence of
virality:

| Metric | V3 baseline |
| --- | ---: |
| Top-1 human acceptance | 100.0 |
| Pairwise ranking accuracy | 100.0 |
| Recall@5 | 100.0 |
| Boundary completeness | 100.0 |
| Caption readability | 92.7143 |
| Visual subject coverage | 70.2663 |

Visual subject coverage is the weakest component. The tutorial fixture is
23.864 and the current corpus contains only seven fixtures. A claimed
30-project V2/V3 comparison would therefore be fabricated; the larger,
anonymized consecutive-project dataset remains required.

## Fifteen largest root source files

| Lines | File |
| ---: | --- |
| 7,658 | `shorts_generator/local/clipper.py` |
| 5,927 | `server/render-job.cjs` |
| 5,848 | `server/analysis.cjs` |
| 2,937 | `server/app.cjs` |
| 2,834 | `shorts_generator/highlights.py` |
| 2,594 | `server/scoreboard-ocr.cjs` |
| 2,581 | `server/pipelines/narrated-short/animation/motion-calibration-corpus.cjs` |
| 2,550 | `server/match-event-truth.cjs` |
| 2,094 | `server/jobs.cjs` |
| 1,849 | `server/adapters/sqlite-persistence-adapter.cjs` |
| 1,836 | `server/edit-plan.cjs` |
| 1,732 | `server/rendered-goal-proof.cjs` |
| 1,693 | `server/render.cjs` |
| 1,414 | `shorts_generator/ranker.py` |
| 1,397 | `shorts_generator/pipeline.py` |

## State and import findings

- No confirmed root Python static import cycle was found. The failures came
  from lazy package attributes combined with string-based patches, not a
  genuine module cycle.
- `hook_gate_v3.py` owns process-global memory caches.
- `config.py` materializes environment-derived configuration as module globals.
- several Node modules own module-scope registries/caches and must be injected
  or reset explicitly in tests.
- the research runner previously imported its entire live video/LLM dependency
  graph even for deterministic offline evaluation.

## Output safety

This stabilization slice changes imports, tests, dependency composition, CI,
and protocol validation only. It does not change clip selection, timing,
caption layout, pixels, audio filters, encoding, or human-review gates.
Consequently no intentional video-output change is introduced. Existing
pixel/timeline/render characterization tests remain the regression proof.

## First modularization slice

| Original module | Before | After | Extracted responsibility |
| --- | ---: | ---: | --- |
| `hook_gate_v3.py` | 1,146 | 1,037 | deterministic report serialization → `hook_gate_report.py` (142) |
| `production_workflow.py` | 1,051 | 991 | FFprobe/OpenCV metadata probes → `media_probe.py` (82) |

Public imports remain compatible. HookGate regression/evaluation tests and
production workflow characterization tests pass after the split.

## Final Node verification

After replacing the per-file timeout with one bounded suite timeout and
removing the cancelled production-infrastructure slice, the complete Node
suite produced 1,585 tests: 1,580 passed, 5 skipped, 0 failed, and 0 cancelled
in 87.1 seconds. Lint and build smoke also passed.
