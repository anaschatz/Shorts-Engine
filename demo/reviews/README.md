# Side-by-Side Operator Reviews

Use this folder for small JSON review files that score a generated short against a reference short.

Run without manual scoring:

```bash
npm run demo:compare
```

Run with an operator review:

```bash
npm run demo:compare -- --review=demo/reviews/example-side-by-side-review.json
npm run demo:human-review -- --reference=manual-downloads/shortsengine-reference-rZZUzMSfaQ.mp4 --review=demo/reviews/example-side-by-side-review.json
```

Review files must contain workspace-relative video references only. Do not add raw videos, screenshots, logs, absolute local paths, tokens, storage keys or provider output to this folder.

The rubric scores each criterion from `0` to `5`:

- `0`: unusable or misleading
- `3`: understandable but needs product/AI work
- `5`: strong product-quality result

Critical flags such as `falseGoalClaim`, `wrongMoment`, `badCrop`,
`captionMismatch`, `textBlocksAction`, `missingPayoff` and `reactionOnly`
block product readiness even when the generated video is structurally correct.

`demo:human-review` can read the generated video from
`demo/results/youtube-live-e2e-latest.json` after an authorized live proof. If no
review JSON is provided, it writes a safe pending report so the operator can
score action sequence, framing, captions, false-goal safety and reference-style
pacing from playback.

The local UI uses the same rubric through `GET /api/review/latest` and
`POST /api/review/human`. The API accepts only safe workspace-relative MP4 refs,
bounded notes, known 0-5 criterion ids, known flags and leak-guarded payloads.
Generated/reference video previews are served through `/api/review/media` only
for `manual-downloads/*.mp4`; reports and public responses must never include
raw local paths, storage keys, logs, tokens or provider output.

Public review responses are allowlisted summaries, not raw persisted reports.
Only known metric keys, known human flags, sanitized criterion summaries and
safe MP4 refs are returned. If generated/reference refs are malformed, product
readiness stays locked in the public response even if a persisted report claims
otherwise.
