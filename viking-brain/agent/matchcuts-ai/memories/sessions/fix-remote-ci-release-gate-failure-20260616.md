# Session Memory: fix-remote-ci-release-gate-failure-20260616

Created: 2026-06-16T19:50:00.000Z

## Summary

Remote CI proof for commit `2b2cc17924c2b11797ab70747b9e738ade77afd7`
found that `ShortsEngine CI` run `27641941499` failed in the `Release gate`
job at the `Verify runtime tools` step. Structured metadata was enough for
diagnosis, so no raw logs or artifacts were downloaded or persisted.

## Decisions

- Install the Ubuntu `ffmpeg` package explicitly in CI before runtime verification.
- Keep `ffmpeg -version` and `ffprobe -version` as hard release-gate checks.
- Enforce the FFmpeg setup through `verify-release-gate`, `static-lint`, and a focused release-gate test.
- Preserve failure-only artifacts, no browser skip, and no real cloud integration in default CI.

## Follow-Up

After local validation, commit and push a fix-forward commit, then rerun
`npm run github:doctor`, `npm run remote:ci`, and `npm run remote:ci:proof`
against the new exact commit.

