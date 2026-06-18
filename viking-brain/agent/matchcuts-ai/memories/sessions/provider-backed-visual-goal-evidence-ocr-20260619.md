# Session Memory: Provider-Backed Visual Goal Evidence + OCR Confirmation

Date: 2026-06-19

## Decisions
- Extended the existing goal evidence provider instead of adding route-level logic.
- Added a safe OCR/scoreboard evidence contract with deterministic fallback.
- Required strong confirmation for `valid_goal`; ambiguous OCR and celebration/intro footage fail closed.
- Added eval coverage for OCR-confirmed multi-goal output and explicit intro/celebration exclusions.

## Validation So Far
- Focused tests passed:
  - `tests/goal-evidence-provider.test.cjs`
  - `tests/eval.test.cjs`
  - `tests/youtube-runtime.test.mjs`

## Limitations
- The local fallback consumes structured OCR evidence; live YouTube clips still need a real OCR/vision provider or frame-level extractor that can populate that contract.
- No paid/external provider is enabled by default.
