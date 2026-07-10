# Ball-First Dynamic Auto-Framing + Scoreboard Composition

Decision:

- Football shorts use `ball_follow` only when bounded local tracking provides reliable ball/action evidence.
- The crop follows the action with hysteresis and a maximum normalized pan speed of `0.18` per second.
- When tracking is uncertain, rendering falls back to the conservative wide-safe composition.
- The source scorebug is extracted from its source ROI, synchronized with source time, and rendered once as a small fixed overlay.
- The original scorebug area is suppressed before overlay composition so the final frame cannot contain duplicate scoreboards.
- Tracking remains a framing signal only and must never create or confirm a goal claim.

Rendered proof:

- The authorized source `WuuGus5Obkg` produced a fresh `1080x1920` MP4 with a duration of `111.75` seconds.
- The strict live output gate reported five counted goals, five covered goals, and no missing goal numbers.
- The final crop plan contained 22 bounded keyframes with tracking confidence `0.92`, ball confidence `0.88`, player confidence `0.84`, and maximum pan speed `0.18`.
- Human inspection of the final video and per-goal contact sheets confirmed that all five goal sequences are visible in the rendered MP4.

Safety and limitations:

- FFmpeg is invoked with argument arrays; raw provider output, frame bytes, paths, storage keys, and credentials are not exposed in public reports.
- Render acceptance still requires the existing counted-goal, visible-finish, replay, celebration, and filler gates.
- The offline research gate returned `discard` with no score regression because its fixtures do not measure rendered pixels. That result must be recorded honestly and must not be presented as a `keep`.
- For goals 1 and 5, automated semantic role timestamps can land later than the human-visible finish even though the complete goal phase is present. Improving role timestamp precision remains follow-up work.
