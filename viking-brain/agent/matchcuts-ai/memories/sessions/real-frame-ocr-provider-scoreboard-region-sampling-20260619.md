# Session Memory: Real Frame OCR Provider + Scoreboard Region Sampling

Date: 2026-06-19

## Decisions
- Added a dedicated scoreboard OCR boundary instead of putting OCR logic in routes or render orchestration.
- Kept deterministic local fallback as the default so tests, eval and local demo do not need API keys or paid providers.
- Wired OCR evidence into goal evidence before highlight/edit-plan generation.
- Added provider-aware goal typing so unconfirmed ball-in-net with ambiguous OCR becomes decision-unclear/chance content, not a confirmed goal.
- Kept visual-only ball-in-net behavior compatible outside provider-backed eval while making provider evidence authoritative when present.

## Validation
- Focused OCR/eval/render tests passed.
- Eval passed with aggregate score 99 across 25 fixtures.

## Limitations
- Real live OCR remains degraded unless a local/external OCR runtime is explicitly enabled.
- The deterministic fallback consumes structured fixture/provider hints; it does not infer score text from pixels.
