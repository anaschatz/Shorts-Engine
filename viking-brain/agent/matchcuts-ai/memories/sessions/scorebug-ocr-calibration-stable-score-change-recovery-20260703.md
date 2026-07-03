# Session Memory: Scorebug OCR Calibration + Stable Score Change Recovery

Created: 2026-07-03

## Summary

Started the scorebug OCR calibration milestone for the `KxGedHh0Ruc` live YouTube blocker. The immediate fix focuses on bounded scorebug-first OCR scans and actionable diagnostics, not on inventing goals or bypassing the final video output gate.

## Decisions

- Keep scorebug-first OCR bounded to compact/top scoreboard ROI candidates and exclude broad top-band scans from the long-source first pass.
- Use a smaller preprocessing set in scorebug-first mode to reduce per-chunk timeout risk.
- Add chunk-level safe diagnostics for sampled timestamps, ROI candidates, selected ROI, OCR observation counts, normalized score candidates, rejected reasons, stable score decisions and next actions.
- Preserve OCR as support-only evidence; stable score changes still need visual/live-phase support before rendering.

## Validation

- Focused OCR/render/YouTube runtime tests should pass before full validation.
- Live proof should be rerun only with explicit rights and operator flags, and should either produce a gated MP4 or a structured failure explaining missing score/phase evidence.

## Limitations

- This milestone improves observability and runtime bounds. It does not guarantee the live source will yield all expected counted goals until the real OCR runtime can read the broadcast scorebug reliably across chunks.
