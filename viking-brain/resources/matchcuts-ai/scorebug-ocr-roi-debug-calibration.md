# Scorebug OCR ROI Debug Calibration

## Purpose

Long YouTube proofs can fail before render when the scorebug is unreadable. The failure report must explain which scorebug regions were attempted instead of returning `attemptedRoiCount: 0` while `roiCandidateIds` are present.

## Contract

- Chunk summaries keep actual OCR results separate from planned attempt diagnostics.
- `sampledFrameCount` remains the actual OCR adapter result.
- `plannedFrameCount` is derived from chunk sampling timestamps.
- `attemptedRoiCount` is derived from candidate scorebug ROI ids.
- `attemptedObservationCount` is derived from planned frames multiplied by candidate ROI ids unless the OCR adapter reports a larger actual attempt count.
- These fields never create score changes, goal events, or valid-goal evidence.

## Safe Failure

When no readable score is found, reports should show:

- `scorebugDebug.state: scorebug_unreadable` or a timeout/failure state.
- `scorebugDebug.reasonCodes` including `scorebug_roi_candidates_attempted` and `scorebug_no_readable_roi`.
- Per-chunk rejected reasons such as `scorebug_no_readable_roi`, `scorebug_frame_or_crop_unavailable`, or timeout codes.
- No raw OCR text, stdout, stderr, local paths, storage keys, tokens, cookies, or generated MP4 success.

## Operator Next Action

Enable local OCR QA only for authorized debugging:

```bash
SHORTSENGINE_SCOREBOARD_OCR_ENABLED=1 \
SHORTSENGINE_SCOREBOARD_OCR_PROVIDER=local \
SHORTSENGINE_SCOREBOARD_OCR_QA_ARTIFACTS=1 \
npm run youtube:proof:operator
```

The resulting contact-sheet refs are local, bounded, and support-only. OCR cannot confirm goals without matching football action evidence.
