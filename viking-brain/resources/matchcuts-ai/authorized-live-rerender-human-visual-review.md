# Authorized Live Re-render + Human Visual Review Loop

## Purpose

This milestone connects authorized YouTube live proof to product-quality review.
The live proof can now produce a safe generated-video artifact reference, and
the human visual review runner turns that artifact plus a reference short into a
review report.

## Operator Flow

Run live proof only after rights confirmation:

```bash
SHORTSENGINE_YOUTUBE_INGEST_ENABLED=1 \
SHORTSENGINE_YOUTUBE_LIVE_E2E=1 \
SHORTSENGINE_YOUTUBE_LIVE_E2E_RIGHTS_CONFIRMED=1 \
SHORTSENGINE_YOUTUBE_LIVE_E2E_URL="<authorized-url>" \
SHORTSENGINE_YOUTUBE_SMOKE_ALLOW_UNLISTED=1 \
npm run youtube:proof:operator
```

The live wrapper passes `SHORTSENGINE_YOUTUBE_SMOKE_SAVE_DOWNLOAD=1` to the
smoke runner. The verified MP4 is saved under `manual-downloads/`, and the proof
report includes `generatedArtifact.relativePath`, ids, duration/size metadata
and `downloadVerified: true`.

Then run:

```bash
npm run demo:human-review -- --reference=manual-downloads/shortsengine-reference-rZZUzMSfaQ.mp4
```

Without a human review JSON, the report status is `pending_human_review` and
`productReady: false`. With a review JSON under `demo/reviews/`, the report can
become `product_ready` only if critical criteria pass.

The browser UI can now apply the same review contract through
`GET /api/review/latest` and `POST /api/review/human`. Generated/reference
previews are limited to safe `manual-downloads/*.mp4` refs through
`/api/review/media`, and product readiness remains false until explicit operator
scores pass with no critical flags.

## Review Checklist

The human visual checklist covers:

- real action or goal sequence
- shot/contact
- ball trajectory, goal mouth, keeper and payoff where available
- reaction used as support only
- payoff not cut early
- ball/player framing
- caption/action alignment
- no false goal claim
- text not blocking critical action
- reference pacing and editing energy

## Safety Contract

- No live proof runs without explicit rights confirmation.
- No cookies, browser sessions, private-video tokens or bypass behavior.
- Reports include only safe relative refs.
- Raw downloader logs, absolute paths, storage keys, cookies and tokens are not
  written.
- Generated videos under `manual-downloads/` and reports under `demo/results/`
  are ignored by git.

## Limitation

Machine structural metrics are not creative truth. The human visual review
report keeps `pending_human_review` until an operator scores playback against the
reference.
