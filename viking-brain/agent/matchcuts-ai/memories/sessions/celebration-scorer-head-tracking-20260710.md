# Session Memory: Celebration Scorer Head Tracking

## Decisions

- Rejected the first skin-color detector after human review showed false head counts on crowd and advertising regions.
- Added an optional Apple Vision adapter behind the tracking boundary, using face-first detection and person-backed head estimation for side profiles.
- Added early post-finish scorer lock and rejected large target jumps after broadcast camera cuts.
- Kept goal truth independent from tracking and preserved `goalClaimAllowed: false`.
- Tightened render QA so strict proof counts only validated face/person keyframes for every goal.

## Validation Snapshot

- Research baseline: quality `98.2`.
- Research experiment: `discard`, score delta `0`, no guardrail regressions. The current research rubric does not inspect rendered pixels.
- Focused tests: `135/135` passed after the final confidence mapping regression test.
- First fresh proof exposed the false-positive skin detector during human review.
- Second proof failed honestly with `celebration_head_tracking_incomplete`, exposing a confidence-field integration bug.
- Final integrated dry-run produced six Vision crop keyframes across all five goals.
- Final fresh live proof passed with five tracked goals and no missing goal numbers.
- Human before/after inspection confirmed visibly improved scorer framing, especially goals 1 and 2.

## Limitations

- Apple Vision is available only on supported macOS operator environments; other platforms use safe fallback behavior.
- Foreground continuity is not biometric identity recognition.
- Some final frames contain unavoidable source-camera occlusion or cuts to supporters.
- Generated MP4s, contact sheets, and proof reports remain untracked artifacts.
