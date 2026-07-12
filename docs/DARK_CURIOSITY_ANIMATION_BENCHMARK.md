# Dark Curiosity Animation Benchmark Runbook and Report

Status: Slice A passed with documented limitations

Run date: 2026-07-13

Production default changed: no

## Runtime decision

The benchmark uses the official `@hyperframes/producer` package pinned exactly to `0.7.55`. The lockfile also resolves its HyperFrames core and engine runtime to `0.7.55`. Official package metadata requires Node.js 22 or newer; the proof ran on Node 22.23.0 with local Google Chrome and FFmpeg/FFprobe 8.1.1. HyperFrames is Apache-2.0 under the upstream repository license.

The programmatic API was verified from the published type declarations and used directly:

```text
createRenderJob(config)
executeRenderJob(job, projectDir, outputPath, onProgress, abortSignal)
resolveConfig(overrides)
```

Only `@hyperframes/producer` is a direct project dependency. There is no global installation, floating `npx`, GitHub-main dependency, downloaded skill, GSAP dependency, cloud API, billing, or API key.

Official references:

- https://github.com/heygen-com/hyperframes
- https://github.com/heygen-com/hyperframes/releases
- https://github.com/heygen-com/hyperframes/blob/main/LICENSE
- https://www.npmjs.com/package/@hyperframes/producer/v/0.7.55

## Commands

Readiness and no-mutation compilation:

```bash
npm run dark-curiosity:animation:doctor
npm run dark-curiosity:animation:benchmark -- --dry-run --width both
```

Explicit real render:

```bash
npm run dark-curiosity:animation:benchmark -- --render --yes --width both
```

The default is dry-run. A real render is rejected unless both `--render` and `--yes` are present. Browser work, composition HTML, request JSON, and partial output live under `os.tmpdir()` and are removed only after the child process closes. Successful MP4, contact sheet, and manifest files are copied to the ignored directory:

```text
data/benchmarks/dark-curiosity-animation/wow-signal/
```

## Measured results

| Metric | 720×1280 | 1080×1920 | Target | Result |
|---|---:|---:|---:|---|
| Duration / frames / FPS | 10.000s / 300 / 30 | 10.000s / 300 / 30 | exact | pass |
| Codec / pixel format | H.264 / yuv420p | H.264 / yuv420p | H.264 / yuv420p | pass |
| Render duration | 14.476s | 14.898s | 1080p <120s | pass |
| Peak renderer RSS | 169 MiB | 178 MiB | <4096 MiB | pass |
| Changed sampled transitions | 100% | 100% | ≥90% | pass |
| Unique sampled frames | 100% | 100% | ≥90% | pass |
| Sampled stasis | 3.45% | 6.90% | <15% | pass |
| Mean absolute motion-energy proxy | 0.008274 | 0.008194 | >0.0002 | pass |
| Caption-safe template bound | pass | pass | no foreground below 74% | pass |
| Declared clipping | none | none | none | pass after visual fix |

All automated manifest checks passed. The 720p proof was rendered twice after the title-clipping fix. Both runs had identical:

- `AnimationIR` content hash;
- engine composition hash;
- all 30 sampled decoded-frame hashes;
- final MP4 SHA-256.

The repeated renders took 14.649s and 14.476s with peak RSS of 173 MiB and 169 MiB respectively.

## Visual assessment

The benchmark is materially better than the sparse keyframe path. It visibly delivers continuous waveform drawing, pulse expansion and decay, intersecting beams, a restrained camera push, waveform-to-evidence transformation, and a matched payoff transition. Object permanence is clear, the hierarchy is readable, the motion is smooth, and the visual language is original rather than a copy of 3Blue1Brown assets or branding.

Strictly, this is still a strong technical prototype—not a finished explanatory-animation system:

- the “morph” is a coordinated path fade/node scale and rotation, not a true topology-preserving path morph;
- only two template families and one story are exercised;
- the bottom 26% caption reserve is safe but looks too empty in a silent visual master;
- typography is engine-owned and bounded, but not yet a fully developed type system;
- motion-energy QA is deterministic pixel-difference sampling, not calibrated OpenCV optical flow or jerk analysis;
- safe-zone and clipping checks combine fixed template bounds with human contact-sheet review; they do not yet use OCR or per-pixel entity masks;
- CSP blocks external requests and there are no remote assets, but HyperFrames uses an internal loopback file server. A packet/request audit was not recorded, so the evidence supports “zero external network” rather than literally zero socket activity;
- deterministic proof covers one repeated 720p fixture, not a cross-machine or cross-Chrome-version guarantee.

These limitations block a production-default switch. They do not justify a Motion Canvas fallback because HyperFrames met the fundamental benchmark criteria.

## Rollback and cleanup

The provider is registered only as `hyperframes_benchmark`. The current production Dark Curiosity pilot still uses its existing SVG keyframe renderer. Removing or disabling the benchmark provider therefore does not change production output. Timeout, cancellation, worker failure, malformed progress, and output tampering map to bounded public errors; partial MP4 and generated composition files are removed after child exit.

Generated MP4s, PNG contact sheets, manifests, temporary HTML, Chrome state, and caches are ignored and are never committed.
