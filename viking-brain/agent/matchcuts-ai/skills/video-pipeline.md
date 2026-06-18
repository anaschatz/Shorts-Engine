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
8. For live YouTube proofs, verify the public render plan summary before trusting the MP4 artifact.
9. For long sources, sample scene/audio/frame candidates across the full timeline before selecting moments.
10. Render preview.
11. Export final formats.

Every step needs schema validation, timeout, retry, idempotency, and traceable artifacts.

For long football sources, default to multi-moment compilation when enough safe post-intro phases exist. The proof/report must show segment timestamps, captions, animation cues, framing mode and artifact hash so stale videos cannot be mistaken for new output.

When explicit ball-in-net/goal sequence evidence exists, compilation should include all detected goal coverage candidates before filler phases. In fallback mode, keep labels neutral rather than inventing goals.
