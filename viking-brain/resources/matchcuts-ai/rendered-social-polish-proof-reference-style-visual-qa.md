# Rendered Social Polish Proof + Reference-Style Visual QA

## Purpose

Use this milestone when ShortsEngine must prove that social polish is visible in the generated MP4, not only present in an edit plan or JSON metric.

## Contract

- The proof artifact must be a fresh `manual-downloads/*.mp4` reference with a unique path, verified download metadata, and FFprobe status `passed`.
- The first two seconds must contain an evidence-backed hook with no false goal claim.
- Captions must include rendered word-by-word timing with active-word highlight support, readable sizing, outline/shadow-safe placement, and an opening hook caption in the first two seconds.
- Multi-segment shorts must report rendered transition coverage and no hard-cut fallback.
- Counted-goal segments must retain visible buildup, shot, finish and confirmation. Replay-only, celebration-only and random chance segments fail proof.
- Audio/style policy must remain rights-safe: no bundled copyrighted/trending audio by default and no mirroring, watermark hiding or copyright-evasion transforms.

## Implementation Notes

- `server/rendered-social-proof.cjs` owns the reusable report contract and failure reasons.
- `demo/run-youtube-live-e2e.mjs` includes `renderedSocialPolishQA` in output proof and fails strict proof with `YOUTUBE_LIVE_E2E_SOCIAL_POLISH_FAILED` when the MP4 does not pass.
- `demo/run-local-video-proof.mjs` applies the same gate after FFprobe and discards the generated output when social polish proof fails.
- `demo/run-youtube-smoke.mjs` preserves sanitized hook, caption, animation, audio and creative-style summaries so live proof can inspect them safely.

## Safety

- Reports must never include raw logs, raw provider/downloader output, storage keys, tokens, cookies or absolute local paths.
- Failed proof should return structured reasons such as missing hook, missing dynamic word captions, hard-cut fallback, non-goal filler or unsafe audio/style policy.
- Generated MP4s and reports remain artifacts only; do not stage them in git.
