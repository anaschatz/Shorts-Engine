# Fresh Rendered Football Proof + Visual Frame QA

Decision:

- Fresh proof reports must not rely only on edit-plan or JSON metrics.
- Local proof now requires ffprobe, rendered social-polish QA, and bounded visual-frame QA before a generated MP4 can be reported as passed.
- Visual-frame QA decodes sampled timestamps from the final MP4 with FFmpeg using safe argument arrays.
- Reports keep only safe metadata: relative MP4 ref, frame timestamps, decode status, crop/action framing summary, caption obstruction risk, and failed reason codes.
- Raw frames, raw FFmpeg output, absolute paths, storage keys, cookies, tokens, and provider logs must never be written to reports.

Failure behavior:

- If visual-frame QA fails, the generated proof artifact is discarded.
- `LOCAL_VIDEO_PROOF_VISUAL_QA_FAILED` keeps the report failed and points the operator at crop/tracking/caption obstruction issues.
- YouTube live proof includes `visualFrameQA` and `actionFramingVerdict` summaries for comparison, while local proof is the strict fresh-MP4 visual gate.

Checks:

- Focused tests cover bounded frame sampling, unsafe/latest MP4 refs, decode failures, caption obstruction, unsafe pan/crop, and local proof artifact discard.
