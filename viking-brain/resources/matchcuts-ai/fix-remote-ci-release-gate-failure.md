# Fix Remote CI Release Gate Failure

## Context

- Remote run: `27641941499`
- Workflow: `ShortsEngine CI`
- Job: `Release gate`
- Failing commit: `2b2cc17924c2b11797ab70747b9e738ade77afd7`

## Safe Diagnosis

Structured GitHub Actions metadata showed the first failing step was `Verify runtime tools`.
All application checks after that step were skipped. The workflow verified `ffmpeg` and
`ffprobe`, but did not install the Ubuntu `ffmpeg` package first, so the remote runner
depended on image-specific preinstalled tools.

## Fix

Add an explicit `Install FFmpeg tools` step before `Verify runtime tools`:

- `sudo apt-get update`
- `sudo apt-get install -y --no-install-recommends ffmpeg`

Keep the existing `ffmpeg -version` and `ffprobe -version` verification. The release-gate
verifier and static lint now enforce this runtime setup contract.

## Safety Notes

- No raw GitHub logs or artifacts are persisted.
- Failed job summaries include only safe job/step names.
- Browser runtime skip remains forbidden in the release gate.
- Failure artifacts remain failure-only and allowlisted.
- Real cloud integration remains opt-in and outside default CI.

