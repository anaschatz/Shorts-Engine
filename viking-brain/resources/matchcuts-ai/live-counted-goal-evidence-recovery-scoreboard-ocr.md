# Live Counted-Goal Evidence Recovery + Scoreboard OCR Anchoring

Date: 2026-06-22

## Purpose

Live YouTube proof for `gxiRyFZXJV8` must fail closed unless ShortsEngine can prove counted-goal evidence for the expected 3 goals. Goal evidence must come from explicit sources such as stable scoreboard score changes, scoreboard/OCR observations, ball-in-net plus confirmation, referee/VAR/score confirmation, or reliable caption/commentary evidence.

## Implementation Notes

- `server/render-job.cjs` now logs bounded evidence trace fields when valid-goals-only planning yields no candidate edit plan.
- The trace includes OCR attempted/enabled state, provider mode, observation counts, score-change counts, stable score-change counts, counted-goal event counts, per-candidate missing evidence and a safe `nextAction`.
- `demo/run-youtube-live-e2e.mjs` carries those fields into failed `outputProof` reports and adds pre-render `phase`/`code` metadata so download failures do not incorrectly point operators at OCR.
- Live proof supports an explicit operator alias: `SHORTSENGINE_YOUTUBE_LIVE_E2E_SCOREBOARD_OCR=1` maps the isolated proof server to local scoreboard OCR. `SHORTSENGINE_YOUTUBE_LIVE_E2E_SCOREBOARD_OCR_QA=1` enables safe relative OCR QA artifacts for local crop debugging.
- Defaults remain safe: no YouTube ingest, no local OCR, no cookies/tokens, no paid provider, no MP4 proof unless render/output gates pass.

## Current Live Proof Result

- The first live proof reached the local job but failed with `YOUTUBE_SMOKE_JOB_TIMEOUT` before OCR evidence was produced.
- The retry with a longer job timeout failed earlier with `YOUTUBE_DOWNLOAD_FAILED`.
- No MP4 was generated. The report stayed fail-closed with `outputMp4: null`, `ffprobe.status: "skipped"`, `logsDownloaded: false`, and `artifactsDownloaded: false`.
- Latest report path: `demo/results/youtube-live-e2e-latest.json`.

## Validation

- `npm run lint`
- `npm run build`
- `npm test`
- `npm run eval`
- `npm run eval:reference`
- `npm run youtube:doctor`
- `npm run demo:fixture`
- `npm run ocr:smoke`
- `npm run ocr:qa:review`
- `npm run demo:smoke`
- `npm run demo:browser`
- `npm run demo:browser:ci`
- `npm run ci:reports`
- `npm run release:check`
- `npm run brain:health`

## Next Step

Fix the live downloader/environment blocker or provide a rights-cleared MP4 source so the evidence recovery path can reach scoreboard/OCR analysis and produce either 3/3 counted-goal proof or a render-stage missing-evidence trace.
