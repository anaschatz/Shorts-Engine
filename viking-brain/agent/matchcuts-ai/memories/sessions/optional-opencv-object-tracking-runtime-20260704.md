# Optional OpenCV Object Tracking Runtime - 2026-07-04

## Decisions

- Added an optional OpenCV tracking adapter without adding OpenCV or Python as required dependencies.
- Kept the default provider deterministic and local for tests/eval/demo.
- Added safe runtime detection for Python/OpenCV capability without exposing paths or raw command output.
- Added rendered action-framing proof so a final report can fail when the crop plan is unsafe even if JSON tracking confidence looks high.

## Safety

- Tracking cannot produce goal claims.
- Missing OpenCV, import failure, timeout and invalid output become structured fallbacks.
- `soft_follow` requires reliable ball/player/action evidence; uncertain tracking falls back to wide-safe framing.
- Public reports do not expose frame local paths, stdout/stderr, tokens, storage keys or raw provider errors.

## Validation Scope

- Focused tests cover disabled/missing OpenCV fallback, injected runtime output, invalid output, safe crop calibration and rendered framing proof.
- Eval fixtures cover reliable edge action and low-confidence fallback behavior.

## Limitation

- The optional Python/OpenCV path is a conservative object-saliency adapter, not a full football ball detector. It improves crop hints only when confidence is strong; otherwise the product deliberately falls back to wide-safe framing.
