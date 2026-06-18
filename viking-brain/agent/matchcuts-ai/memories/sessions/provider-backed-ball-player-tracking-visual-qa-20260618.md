# Session Memory: Provider-Backed Ball/Player Tracking + Visual QA

## Decisions

- Added a dedicated tracking provider adapter boundary for ball tracks, player
  clusters, action bounds and action centers.
- Kept the default provider deterministic, local and mock-safe so eval and demos
  do not need API keys.
- Integrated provider tracking output into visual tracking and crop calibration
  without moving heavy logic into routes.
- Exposed visual QA metadata on candidate edit plans, render-job records and eval
  reports.

## Safety

- Provider output is schema validated before use.
- Unsafe labels, out-of-bounds boxes, leaked paths, storage keys, tokens and raw
  provider values are rejected or stripped.
- Missing providers, runtime failures and timeouts return safe fallback output.
- Tracking evidence cannot create goal claims; goal claims still require
  explicit goal evidence from the goal-evidence layer.
- Wide-safe framing remains the fail-closed default for uncertain tracking.

## Tests

- Added focused tracking-provider tests for deterministic output, validation,
  fallback, timeout, cancellation and no-goal behavior.
- Extended render-job tests to assert provider-backed tracking delegation and
  structured visual tracking logs.
- Extended eval tests and fixtures with tracking provider output and visual QA
  report shape.

## Limitations

- The external provider adapter is contract-ready but not configured as default.
- Real provider selection, credential handling and sampled frame QA previews
  remain future milestones.
