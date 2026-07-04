# Skill: Video Pipeline

Use when implementing backend video processing.

Steps:

1. Ingest and validate media.
2. Scan for malware/media safety.
3. Analyze scenes and camera motion.
4. Transcribe and align word timings.
5. Detect highlights and rank moments.
6. Generate edit plan.
7. Validate AI output.
8. Render preview.
9. Export final formats.

Every step needs schema validation, timeout, retry, idempotency, and traceable artifacts.

Source acquisition:

- Keep YouTube ingest opt-in and rights-confirmed before any source lookup.
- Use the source acquisition service for downloader and operator-approved source cache paths.
- Source cache keys must be YouTube video IDs, never raw URLs.
- Cache hits must copy into managed staging, then pass normal signature, FFprobe, artifact-store and repository validation.
- Cache miss may fall back to downloader; corrupt, oversized or checksum-mismatched cache files fail closed.
- Public reports may include safe cache diagnostics, but never absolute paths, storage keys, raw downloader logs, cookies or tokens.

AI curation:

- Transcript energy belongs behind `server/transcript-energy.cjs`, not inside routes.
- High-energy cues such as exclamations, save/chance/foul/card/VAR/offside language and commentator spikes can boost ranking, but hype-only or crowd-only text is support context.
- Goal claims require explicit goal evidence. Non-event wording like "behind the goal" and decision wording like offside/no-goal must not produce confirmed-goal evidence.
- Reports should expose safe transcript-energy summaries so operators can see why a moment was selected.

Action-aware framing:

- Tracking/crop decisions belong behind `server/tracking-provider.cjs` and `server/visual-tracking.cjs`.
- Allow `soft_follow` only with reliable ball/player/action evidence, contained action bounds and no caption obstruction risk.
- Low-confidence, camera-motion-heavy or obstructed action should fall back to wide-safe framing.
- Crop plans should expose action center, crop mode, tracking confidence, safe margins and max pan speed for QA.

Social-ready output:

- Treat hook-first editing, dynamic word captions, bounded animation cues, audio policy and creative style transforms as validated edit-plan contracts.
- Final output proof should fail closed when the first-two-second hook, readable word-timed captions, safe audio policy or no-evasion styling contract is missing.
- Creative polish may use mild zoom, color grading and caption-safe overlays for clarity; never use mirroring, watermark hiding, scorebug hiding or copyright-evasion behavior.
