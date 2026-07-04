# Optional OpenCV Object Tracking Runtime

## Purpose

Use this resource when ShortsEngine needs provider-backed action framing while keeping tests, eval and demos deterministic without OpenCV.

## Runtime Contract

- The default tracking provider remains `safe-tracking-provider`.
- `opencv-object-tracking` is opt-in through `SHORTSENGINE_TRACKING_PROVIDER=opencv` or `SHORTSENGINE_OPENCV_TRACKING_ENABLED=1`.
- The adapter lives behind `server/adapters/opencv-tracking-adapter.cjs`.
- OpenCV/Python are optional. Missing runtime returns structured fallback instead of crashing the render pipeline.
- The adapter never allows goal claims. `goalClaimAllowed` must stay `false`.

## Safety Rules

- Inputs are bounded to managed sampled frames.
- Frame paths are used only internally and must never be exposed in public reports.
- Runtime detection reports only capability booleans, mode, timeout and safe failure code.
- No raw stdout, stderr, local paths, tokens, cookies, storage keys or provider errors are included in public output.
- If tracking confidence is low, the crop plan must fall back to `wide_safe` or `locked_wide`.
- `soft_follow` is allowed only with reliable ball/player/action evidence, contained action bounds and no caption obstruction.

## Rendered Proof

- `server/rendered-social-proof.cjs` now includes `renderedActionFraming`.
- The proof reports crop mode, tracking provider mode, confidence, fallback usage, ball/player visibility, action safe-zone coverage, text obstruction risk and abrupt pan risk.
- Rendered proof fails if `soft_follow` is used without reliable tracking, action zones are outside the crop/safe area, captions obstruct action or pan speed is unsafe.

## Evaluation

- `039_opencv_right_edge_soft_follow_tracking.json` checks reliable right-edge action can use `soft_follow`.
- `040_opencv_low_confidence_wide_safe_tracking.json` checks low-confidence OpenCV output falls back to `wide_safe` without goal claims.
