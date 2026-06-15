# AI Analysis Layer L2 Details

Source files:

- `server/analysis.cjs`
- `server/transcription.cjs`
- `server/app.cjs`
- `tests/analysis.test.cjs`
- `eval/scoring.cjs`
- `eval/run-eval.mjs`
- `eval/fixtures/*.json`

Core contracts:

- Media signals include duration, resolution, aspect ratio, audio presence, audio peaks, scene changes, high-motion candidates and sample timestamps.
- FFmpeg signal extraction is best-effort; deterministic fallback signals keep tests and local demos stable.
- Transcription uses OpenAI only when `MATCHCUTS_TRANSCRIPTION_PROVIDER=openai` and `OPENAI_API_KEY` are configured; otherwise mock fallback returns timed segments/captions.
- Highlight detection ranks moments with reason codes: `goal_like_phrase`, `audio_peak`, `commentator_emphasis`, `replay_marker`, `scene_change_cluster`, `crowd_reaction`, `tactical_build_up`.
- Candidate edit plans are validated 9:16, 1080x1920 MP4 plans before FFmpeg render.
- The MVP renders the top candidate, but returns candidate plans and highlight metadata in the job payload.
- `npm run eval` measures whether highlight ranking and candidate edit plans match expected football moments across deterministic fixtures.

Safety:

- Provider failures throw safe `AppError` codes.
- API responses do not expose API keys, local paths or raw provider errors.
- Analysis falls back only to deterministic safe moments when transcript/signals are limited.
