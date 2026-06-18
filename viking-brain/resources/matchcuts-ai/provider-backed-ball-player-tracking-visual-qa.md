# Provider-Backed Ball/Player Tracking + Visual QA

## Purpose

ShortsEngine now has a provider-backed tracking boundary for ball, player
cluster and action-center metadata. The default remains deterministic and local,
so tests, eval and demos do not require network access or API keys.

## Contract

- Tracking provider output must be validated before it can influence crop
  planning or visual QA.
- Provider failures, missing clients, timeouts and cancellation must fail closed
  with safe error codes.
- External providers are optional adapters, not defaults.
- Tracking metadata may improve framing confidence, but it must never create or
  upgrade a goal claim.
- `soft_follow` is allowed only when action bounds are reliable and contained by
  the crop box.
- Low confidence, camera motion or missing tracks must fall back to wide-safe
  framing.
- Public reports may include bounded boxes, labels, confidence values and reason
  codes. They must not include frame paths, storage keys, raw provider errors,
  tokens or absolute local paths.

## Metrics

Evaluation reports include:

- `trackingOutputValidity`
- `ballTrackCoverage`
- `playerClusterCoverage`
- `softFollowPrecision`
- `wideSafeFallbackCorrectness`
- `falseGoalFromTrackingRate`

Guardrails:

- `falseGoalFromTrackingRate` must stay `0`.
- Provider fallback remains deterministic and should require no network or API
  keys.
- Wide-safe framing is preferred whenever tracking evidence is incomplete or
  uncertain.

## Limitations

- The local provider is a deterministic adapter used for safety, tests and
  fixture-driven evaluation.
- Real paid or hosted tracking providers must be enabled explicitly through a
  future adapter configuration milestone.
- This layer does not perform brittle computer vision inside the core pipeline.
