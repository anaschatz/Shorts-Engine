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
