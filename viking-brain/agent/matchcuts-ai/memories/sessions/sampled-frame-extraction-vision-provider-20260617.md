# Sampled Frame Extraction + Vision Provider Adapter - 2026-06-17

## Decisions

- Added `server/frame-extraction.cjs` as the bounded FFmpeg sampled-frame boundary.
- Integrated frame sampling into render orchestration before visual analysis.
- Added cleanup of sampled temp frames in the render-job `finally` path.
- Updated `server/vision.cjs` with provider adapters for safe heuristic, local frame inspection and opt-in external provider clients.
- Kept default behavior API-key-free and deterministic for tests/eval/local demo.
- Preserved the no-false-goal rule: visual/frame evidence cannot create a goal claim without explicit goal evidence.

## Safety

- Frame output directories must stay inside staging storage.
- Public `sampledFrames` summaries omit `localPath`, storage keys and absolute paths.
- Zero extracted frames are treated as fallback.
- External vision provider usage requires an injected client and is not enabled by default.

## Focused Checks

- `node --check server/frame-extraction.cjs`
- `node --check server/vision.cjs`
- `node --check server/render-job.cjs`
- `node --check eval/scoring.cjs`
- `node --test --test-concurrency=1 tests/frame-extraction.test.cjs`
- `node --test --test-concurrency=1 tests/vision.test.cjs`
- `node --test --test-concurrency=1 tests/render-job.test.cjs`
- `node --test --test-concurrency=1 tests/eval.test.cjs`

## Limitations

- Local frame inspection is contextual and conservative, not full object tracking.
- A future real provider can be wired through the adapter, but should remain opt-in and validated.
