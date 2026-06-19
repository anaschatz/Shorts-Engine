# Session Memory: OCR QA Manifest Hardening

## Decisions
- Opt-in OCR crop QA artifacts now have a manifest contract.
- `ocr-qa-manifest.json` lives inside `demo/results/ocr-artifacts/<run-id>/`.
- Reports expose only the manifest relative path, bounded crop counts and byte limits.
- Oversized crop artifacts fail closed with safe error codes.

## Safety
- Crop refs must stay under the managed run directory.
- Crop metadata is validated before report exposure.
- No raw OCR text, full frames, stdout/stderr, absolute paths, storage keys or provider output are stored.
- CI still uploads only `demo/results/ocr-latest.json`, not crop artifact directories.

## Validation
- Focused tests cover manifest creation, unsafe refs and oversized crop failure.
- Full release gates should run before commit and push.
