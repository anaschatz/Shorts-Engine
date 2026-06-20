# Scorebug Image Segmentation

## Decision

- `server/scorebug-image-segmentation.cjs` owns focused scorebug crop digit segmentation.
- `server/scorebug-digit-reader.cjs` priority is structured digit reading, focused image segmentation, calibrated fallback, then fail closed.
- Image segmentation is allowed only for focused `scorebug_*` regions and staging-safe crop paths.
- Broad top-band regions, unsafe paths, clock-like digit groups, missing crops, empty crops and unsupported image formats fail closed.

## Safety

- The default local demo/eval path requires no API keys or paid providers.
- The current image parser supports bounded ASCII PGM crops for deterministic tests and QA fixtures.
- Live PNG/JPG scorebug crops are rejected with `unsupported_image_format` until a reviewed decoder/provider adapter is added.
- OCR/digit evidence remains support-only and cannot confirm goals without football action evidence.

## Validation

- Focused tests cover readable synthetic scorebug crops, broad-region rejection, unsafe path rejection, noisy/clock/missing crop rejection, reader priority and local scoreboard OCR integration.
- Release gates run `npm run lint`, `npm run build`, `npm test`, `npm run eval`, `npm run eval:reference`, demo smoke, browser smoke, CI report validation and release check.

## Limitation

- Live YouTube proof for `gxiRyFZXJV8` still fails closed at valid-goal selection. The scorebug QA path reports unsupported live image formats, so the next milestone should add a safe PNG/JPG crop decoder or provider-backed digit segmentation adapter before relying on live scorebug digits.
