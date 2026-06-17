# Session Memory: authorized-live-rerender-human-visual-review-20260618

## Decisions

- Live YouTube proof remains operator-driven and requires explicit rights
  confirmation before downloader/server work.
- Successful live proof now asks the smoke runner to save the verified MP4 under
  `manual-downloads/` and exposes only safe `generatedArtifact` metadata.
- `manual-downloads/` is ignored by git so generated videos are not committed.
- Added `npm run demo:human-review` to build a separate human visual review
  report from live proof or direct generated/reference refs.
- Pending reports keep `productReady: false` until a human review JSON is
  supplied.

## Review Contract

The human visual checklist covers action sequence visibility, shot/contact,
ball/goal-mouth/keeper/payoff evidence, reaction-as-support, payoff timing,
ball/player framing, caption/action alignment, no false goal claims, text
obstruction and reference-style pacing.

## Safety

- No raw downloader logs, absolute paths, storage keys, cookies, tokens or raw
  provider output are written to reports.
- Missing live proof, failed proof or missing generated artifact fails closed.
- Machine structural metrics remain separate from human creative judgement.

## Validation To Run

- Focused tests for YouTube runtime, side-by-side review and human visual review.
- Full lint, build, tests, eval, reference eval, feedback summary, brain health,
  demo/browser smokes, CI reports and release check before commit/push.
