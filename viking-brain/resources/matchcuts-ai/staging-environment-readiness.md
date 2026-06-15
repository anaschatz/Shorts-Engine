# Staging Environment + Secrets Readiness

ShortsEngine now has a staging environment contract and deterministic readiness gate.

## Commands

- `npm run env:check`
- `npm run release:check`
- `npm run release:evidence`

## Contract

- `.env.example` is safe to commit and contains no real secrets.
- `docs/ENVIRONMENT.md` documents runtime, upload/media, FFmpeg, worker, storage, persistence, transcription, signed delivery, cloud and browser/CI flags.
- `tools/release/check-environment.mjs` validates defaults, numeric bounds, adapter/provider readiness and no-leak output.

## Safety Rules

- Mock transcription remains the default.
- Local storage and local persistence remain the defaults.
- Real OpenAI transcription requires an explicit provider plus configured credential.
- S3/R2 require bucket and credentials; S3 requires region and R2 requires endpoint.
- GCS stays fail-closed for staging readiness until implemented.
- Real cloud integration remains opt-in and requires the explicit numeric flag.
- Browser runtime skip is rejected in staging/release readiness.
- Environment readiness output must never include raw secret values, absolute paths or storage keys.

## Release Integration

- CI runs `npm run env:check` before lint/build/tests.
- `release:check` includes environment readiness.
- `release:evidence` includes a safe environment readiness summary.
