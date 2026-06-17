# Sampled Frame Extraction + Vision Provider Adapter

## Contract

ShortsEngine now samples bounded still frames before visual analysis.
The boundary lives in `server/frame-extraction.cjs` and is called from `server/render-job.cjs` between media signal extraction and `analyze_visuals`.

Frame extraction must remain:

- bounded by max frame count and max dimensions
- staged only inside configured storage roots
- cancellable through the job signal
- cleaned up after analysis
- safe to fall back to mock metadata when FFmpeg or input frames are unavailable

Public job/render records may include `sampledFrames`, but never `localPath`, absolute paths, storage keys, raw FFmpeg output or provider errors.

## Vision Provider Adapter

`server/vision.cjs` now exposes a provider adapter contract:

- `safe-heuristic`
- `frame-inspection-local`
- `external-vision-adapter`

The local provider can use sampled frames plus candidate windows as contextual evidence.
It does not perform brittle ball/player tracking and does not claim goals.
External vision stays opt-in through an injected client and is not the default for tests, eval or local demo.

## Safety Rules

- Never infer `goal` from goal area, crowd noise, shot-like motion or sampled frames alone.
- Use visual evidence only for `big_chance`, `save`, `foul`, `counter_attack`, `replay_or_reaction` or `unknown_action`.
- Keep default framing wide/safe so the ball and players are not lost to aggressive crop.
- Treat zero extracted frames as fallback, not a successful provider result.
- Clean sampled frame temp files in `finally`.

## Evaluation

Eval remains deterministic and network-free.
Reports include:

- `visualFallbackUsageRate`
- `frameExtractionFallbackUsageRate`
- `sampledFrameCount`

Fixtures can optionally add `frameExtraction` or `sampledFrames` metadata to track frame sampling behavior without requiring real media.

## Tests

Important coverage:

- frame extraction path safety
- bounded frame count
- mock fallback
- cancellation
- public summary no path leakage
- local frame inspection adapter
- external adapter validation
- render orchestration step order
- cleanup after job completion/failure
