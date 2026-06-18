# Session Memory: Real Local OCR Runtime Adapter

Date: 2026-06-19

## Decisions
- Added an opt-in local OCR runtime adapter instead of making Tesseract or any paid OCR provider a default dependency.
- Kept deterministic scoreboard OCR as the default fallback for tests, eval and local demo.
- Implemented scoreboard crop extraction through staging-safe paths with bounded crop count, timeout/cancellation behavior and cleanup.
- Exposed OCR readiness in health/environment checks without leaking binary paths, stdout/stderr or raw OCR text.
- Treated unchanged scoreboard OCR after ball-in-net as offside/no-goal support, not a valid goal confirmation.

## Validation
- Focused OCR, goal evidence and eval tests passed for local runtime parsing, fallback, timeout/cancellation, crop safety and score-unchanged no-goal behavior.
- Environment check passed with scoreboard OCR disabled and deterministic fallback active.

## Limitations
- Local OCR requires the operator to install/configure `tesseract` manually and set opt-in env vars.
- Pixel OCR quality still depends on scoreboard visibility and crop quality; ambiguous/unreadable reads fail closed.
