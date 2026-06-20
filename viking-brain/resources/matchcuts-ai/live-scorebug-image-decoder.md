# Live Scorebug Image Decoder

## Decision

- `server/scorebug-image-decoder.cjs` owns safe PNG/JPG scorebug crop decoding.
- The decoder accepts only staging-safe crop paths and converts live crops to bounded grayscale PGM pixels through an injected FFmpeg runner.
- `server/scorebug-image-segmentation.cjs` keeps direct PGM support for deterministic fixtures and uses the async decoder only when a focused crop is PNG/JPG.
- `server/scoreboard-ocr.cjs` awaits the async digit reader and passes the same staging output directory plus FFmpeg runner to the decoder.

## Safety

- Broad regions are rejected before decode.
- Unsafe paths, missing crops, corrupt images, unsupported formats, missing FFmpeg and decoder timeouts fail closed with safe reason codes.
- Decoder output is temporary and removed after parsing.
- Public reports include decoder status/mode and image segmentation status, but never absolute paths, stderr/stdout, storage keys or provider output.
- Scorebug evidence remains support-only and cannot confirm a goal without football action evidence.

## Validation

- Tests cover PNG decoder contract, path safety, unsupported/corrupt inputs, missing FFmpeg, timeout, cleanup, decoded segmentation and scoreboard OCR score-change integration.
- Live proof should be re-run with `SHORTSENGINE_SCOREBOARD_OCR_QA_ARTIFACTS=1` to confirm live crops no longer fail as `unsupported_image_format`.
