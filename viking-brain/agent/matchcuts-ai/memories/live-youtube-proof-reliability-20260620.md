# Live YouTube Proof Reliability Session

Date: 2026-06-20

## Decisions

- Live YouTube proof now starts the local server with isolated demo data instead of the heavy default `data/` tree.
- Fresh proof cleanup deletes only managed generated MP4 artifacts under `manual-downloads/`.
- The live report now contains `outputProof` with ffprobe status, counted-goal coverage, replay-only segment counts, segment windows and comparison readiness.
- Real proof failures are classified by phase: server readiness, download, render selection or output validation.

## Verification

- Focused YouTube runtime tests passed.
- Full local tests passed with 623 tests.
- Eval, reference eval, feedback summary, brain health and YouTube doctor passed.
- Live proof no longer fails at server readiness; `/health` was reached before ingest.

## Limitations

- Final live proof did not produce an MP4 because the real YouTube run failed at the downloader boundary with `YOUTUBE_DOWNLOAD_FAILED`.
- A prior live run reached ingest/generate and failed with `NO_VALID_GOALS_FOUND`, reporting 0/3 expected counted goals.
- Side-by-side comparison remains blocked until a generated MP4 exists.
