# Real Visual Tracking + Crop Calibration

## Contract

- Visual tracking is conservative and does not claim perfect ball tracking.
- Goal claims still require explicit goal evidence; crop/tracking metadata never
  upgrades a moment to `goal`.
- Low-confidence tracking, broad action bounds and camera motion must fall back
  to `wide_safe` or `locked_wide`.
- `soft_follow` is allowed only when action bounds are contained by the crop box
  and tracking confidence is high.
- Crop plans must keep boxes inside source video bounds and reject negative or
  zero dimensions.
- Caption text zones should avoid action zones when a crop is actually used.

## Metrics

- `cropSafetyScore`
- `actionSafeZoneCoverage`
- `textObstructionRisk`
- `wideSafeFallbackRate`
- `trackingConfidenceCalibration`
- `ballPlayerVisibilityScore`

## Limitations

- The current layer uses sampled-frame metadata, visual labels and fixture
  bounds. It is not a full object detector.
- Wide-safe framing remains the default for live clips until reliable
  provider-backed ball/player tracking is available.
