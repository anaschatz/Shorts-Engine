# Session Memory: Real Visual Tracking + Crop Calibration

## Decisions

- Added a dedicated visual-tracking boundary for conservative action-center and
  action-bounds metadata.
- Added crop calibration with `wide_safe`, `soft_follow`, `center_safe` and
  `locked_wide` modes.
- Kept wide-safe as the default for uncertain clips and camera motion.
- Integrated validated `cropPlan` metadata into edit plans, render-job output,
  eval reports and reference review metadata.

## Safety

- `soft_follow` requires high confidence and contained action bounds.
- Fallback crop modes must preserve the full frame.
- Tracking output never enables goal claims.
- Reports expose bounded boxes, confidence values and reason codes only.

## Tests

- Added focused visual-tracking tests for stable action, low confidence,
  camera motion and unsafe crop rejection.
- Eval now gates crop safety, action safe-zone coverage, text obstruction risk
  and tracking confidence calibration.
