# Broadcast Scorebug Calibration + Real Score Change Extraction

## Decision

- `server/scoreboard-ocr.cjs` now has broadcast scorebug layout profiles for score-only extraction before OCR/digit parsing.
- Score-only crops are created through bounded FFmpeg crop filters with safe staging paths and relative QA refs.
- `server/adapters/local-ocr-adapter.cjs` parses compact score-only text such as `1 0`, `1-0` and OCR variants like `O-I`, while rejecting clocks, team labels and noisy extra digits.
- Scoreboard evidence preserves safe `layoutId` and `scoreOnlyCropRef` metadata through OCR, reader timeline, goal evidence and demo QA reports.
- OCR smoke reports use the stable score timeline when score-change events exist.

## Safety

- Scorebug OCR remains support evidence only; it cannot confirm goals without football action evidence.
- Layout profiles fail closed on unsafe paths, broad regions, missing FFmpeg, missing crops, unreadable digits and impossible score transitions.
- Public reports expose only safe relative crop refs and summary metadata. They do not expose absolute paths, stderr/stdout, logs, provider raw output or secrets.
- Tests, eval and local demo still run without API keys or paid providers.

## Validation

- Focused tests cover score-only parser behavior, score-only crop contract, local OCR score-only precedence, OCR runtime smoke and scorebug digit/image decoder flows.
- Full validation passed locally: lint, build, test, eval, reference eval, feedback summary, brain health, fixture smoke, OCR smoke, OCR QA review, YouTube doctor, demo smoke, browser smoke, browser CI, CI reports and release check.

## Live Proof Result

- Live YouTube proof for `gxiRyFZXJV8` still failed safely with `NO_VALID_GOALS_FOUND`.
- OCR QA found 37 score-only crop attempts, but only 1 readable score-only crop and 0 stable score-change events.
- The blocker is now specific: the live broadcast scorebug digits are still not reliably decoded into stable score changes, even after score-only crop isolation.

## Next Milestone

- Build provider-backed or calibration-backed scorebug digit recognition from the saved score-only crop refs.
- Add per-broadcast calibration fixtures from real QA crops before trying to claim 3/3 counted-goal recovery from scoreboard changes.
