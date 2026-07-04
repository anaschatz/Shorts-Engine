# Resumable Long YouTube Download Proof Unblock Session

Date: 2026-07-04

## Decisions

- Keep default YouTube ingest disabled and rights-gated.
- Add `SHORTSENGINE_YOUTUBE_DOWNLOAD_TIMEOUT_MS` as a preferred downloader timeout alias while preserving `SHORTSENGINE_YOUTUBE_INGEST_TIMEOUT_MS`.
- Add `SHORTSENGINE_YOUTUBE_LIVE_E2E_DOWNLOAD_TIMEOUT_MS` for operator-only long-source proof runs; it is bounded and validated before server/downloader work.
- Distinguish active timeout from stalled timeout with `DOWNLOAD_TIMED_OUT_WITH_PROGRESS` and `DOWNLOAD_STALLED_NO_PROGRESS`.
- Use `yt-dlp --continue` in the safe arg array, but keep resumable partial state disabled by default and clean partials on failure.
- Keep live scoreboard OCR proof job polling bounded but long enough for chunked OCR by applying a 300000ms smoke job timeout only when `SHORTSENGINE_YOUTUBE_LIVE_E2E_SCOREBOARD_OCR=1` and the operator has not set an explicit job timeout.

## Verification

- Focused downloader/ingest tests passed.
- YouTube runtime proof/report tests passed.
- Environment contract tests passed.
- Live rights-confirmed proof for `WuuGus5Obkg` passed the earlier downloader/config blockers and failed safely at `NO_VALID_GOALS_FOUND` in `create_edit_plan`; no MP4 was produced.

## Limitations

- Real YouTube proof can still fail because of operator network, YouTube policy, bot checks or insufficient timeout budget.
- Current live proof still needs stronger valid-goal evidence selection: OCR was attempted, but the proof reported `scoreChangeCount=0` and `countedGoalsIncluded=0`.
- No MP4 proof should be generated unless ingest completes, FFprobe/upload validation passes and the final output gate passes.
