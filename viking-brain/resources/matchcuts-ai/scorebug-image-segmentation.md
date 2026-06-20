# Scorebug Image Segmentation

## Decision

- `server/scorebug-image-segmentation.cjs` owns focused scorebug crop digit segmentation.
- `server/scorebug-digit-reader.cjs` priority is structured digit reading, focused image segmentation, calibrated fallback, then fail closed.
- Image segmentation is allowed only for focused `scorebug_*` regions and staging-safe crop paths.
- Broad top-band regions, unsafe paths, clock-like digit groups, missing crops, empty crops and unsupported image formats fail closed.

## Safety

- The default local demo/eval path requires no API keys or paid providers.
- The current image parser supports bounded ASCII PGM crops for deterministic tests and QA fixtures.
- Live PNG/JPG scorebug crops are decoded through the safe FFmpeg-to-PGM boundary before segmentation.
- OCR/digit evidence remains support-only and cannot confirm goals without football action evidence.

## Validation

- Focused tests cover readable synthetic scorebug crops, broad-region rejection, unsafe path rejection, noisy/clock/missing crop rejection, reader priority and local scoreboard OCR integration.
- Release gates run `npm run lint`, `npm run build`, `npm test`, `npm run eval`, `npm run eval:reference`, demo smoke, browser smoke, CI report validation and release check.

## Limitation

- Live YouTube proof for `gxiRyFZXJV8` should be re-run after decoder changes to measure whether decoded scorebug evidence improves counted-goal discovery.
