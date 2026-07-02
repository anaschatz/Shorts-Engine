# Long-Source YouTube Proof Runtime Session

Date: 2026-07-02

## Decisions

- Live YouTube smoke/proof failures now carry safe `phase`, `step`, `substep`, elapsed time, timeout budget and stale-job details.
- Render jobs store bounded `progressMeta` so the operator can see whether a long run is extracting audio, sampling scorebug frames, running OCR, analyzing visuals or rendering.
- Long YouTube sources run scorebug-first OCR before sampled frame extraction, then merge stable score-change windows into visual candidate windows.
- The valid-goals-only gate remains strict. Runtime improvements should make failures diagnosable, not make invalid MP4 output look successful.

## Verification

- Focused render-job and YouTube runtime tests passed locally after the scorebug-first orchestration fixture used the same counted-goal truth and edit-plan contract as existing YouTube tests.

## Limitations

- Live YouTube proof still depends on operator-enabled downloader/network flags and rights confirmation.
- A real MP4 proof must still pass the final output gate before it can be used for comparison.
