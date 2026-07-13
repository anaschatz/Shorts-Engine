# Dark Curiosity Browser Seek Proof

Status: Slice C2 validated benchmark; production migration not approved

Date: 2026-07-13

## Scope

Slice C2 verifies that the actual compiled HyperFrames composition is random-access deterministic inside headless Chrome. It also exercises external-request containment and malformed timing rejection. It does not change the production narrated renderer, publishing path, visual templates, narration provider, or pilot defaults.

## Commands

```bash
npm run dark-curiosity:animation:seek:doctor
npm run dark-curiosity:animation:seek:proof
npm run dark-curiosity:animation:seek:proof -- --render --yes
```

The CLI is dry-run by default, accepts only the allowlisted Wow Signal fixture, requires both confirmation flags for real rendering, writes only to the ignored benchmark directory, and removes its temporary browser/render staging tree on success or failure.

## Browser random-access proof

The harness loads one engine-owned HTML/SVG composition once and executes this sequence:

```text
27, 76, 27, 209, 76, 241, 209, 291, 0, 241, 291
```

Each seek calls the engine-owned timeline directly and captures a real 720×1280 PNG after the DOM reports the requested frame. No reload occurs between captures.

| Semantic frame | PNG SHA-256 | Result |
| ---: | --- | --- |
| 27 | `5bfbc1a9681b20cc38e9f8dc9b5eebde1a556c012f635aa55d6861cab478e540` | equal after return |
| 76 | `27163ce573f31b4e582f79c1e200f3ad72f2c2597c2ded8f9dff58beef6b064c` | equal after return |
| 209 | `0cbac4598a251edc36a819755ae5f471e76ca004aabe58038927b564bd827911` | equal after return |
| 241 | `6d055775317da188819b215fb0ec9883f747639c8344dad975e063500920d477` | equal after return |
| 291 | `90527a1abfde342b2af5b229a0ce5582a493b4960bc7404466f6288d268ee310` | equal after return |

The composition source is rejected if it uses wall-clock choreography, unseeded `Math.random`, `requestAnimationFrame`, timer accumulation, CSS animation/transition autoplay, or autoplay media. Runtime inspection also requires exactly one registered timeline and zero active browser animations. Browser launch/navigation have bounded timeouts, external DNS is disabled, and raw launch failures collapse to one stable safe code.

## Network containment

The valid proof browser recorded:

- external requests: `0`;
- blocked external requests: `0`;
- external resource classes: none.

An adversarial image request was injected only after CSP bypass inside the isolated test page so it had to reach the interception boundary. The harness recorded one external `image` request, blocked the same request, and returned `BROWSER_EXTERNAL_REQUEST_BLOCKED` without retaining its URL, headers, cookies, query string, or browser log.

The production-like composition itself keeps a restrictive CSP with no connections, media, remote fonts, frames, or objects. The proof harness additionally recognizes HTTP, HTTPS, WS, and WSS protocols and launches Chrome with external DNS disabled.

Strict limitation: these counters come from the dedicated proof browser loading the exact same compiled composition. The internal browser managed by `@hyperframes/producer` remains CSP-constrained and uses no remote assets, but HyperFrames 0.7.55 does not expose its page-level request counters through the current provider API.

## Adversarial timing validation

Thirteen cases fail before any render attempt:

1. unknown beat;
2. word index out of bounds;
3. negative resolved frame;
4. end before start;
5. operation outside scene;
6. anchor outside composition;
7. duplicate operation/target pair;
8. alignment hash mismatch;
9. timing-context hash mismatch;
10. FPS mismatch;
11. duration mismatch;
12. offset overflow;
13. resolved frame disagreeing with its semantic anchor.

All thirteen returned their expected bounded error code. Render attempts: `0`. Partial MP4 artifacts: `0`.

## Repeat-render result

| Property | Run A | Run B |
| --- | ---: | ---: |
| Resolution | 720×1280 | 720×1280 |
| Frames / frame rate | 300 / 30 fps | 300 / 30 fps |
| Duration | 10.000 s | 10.000 s |
| Codec / pixel format | H.264 / yuv420p | H.264 / yuv420p |
| Render duration | 15.495 s | 17.085 s |
| Peak memory | 148 MiB | 161 MiB |
| Sampled stasis | 13.79% | 13.79% |
| MP4 SHA-256 | `72b8bdef4c6f686c7242b154c3e237eb78ffc2d6debeec273ae152dece10f322` | same |

The following comparisons all passed:

- TimingContext hash;
- AnimationIR hash;
- compiled composition hash;
- decoded checkpoint hashes;
- browser random-seek hashes;
- technical metadata;
- MP4 SHA-256.

Key immutable hashes:

- TimingContext: `888847e723a033c2d3a6c5e376739e8c7de46463143328d5f90f0e2c19cce01b`;
- AnimationIR: `53f5cd4ee107a0f1d4592502fcd27ed386fc86446fbdd3a7338b30118e273480`;
- composition: `71cff9517f26a3c909b74d2654e9b2d77845fb0a033f914e84de86637884886b`;
- strict proof manifest: `43b37c56b1ef80c45606c64b5ecc47491ac2ef572b1ca1284369a59a0ba64f6c`.

## Visual inspection

The seven-frame contact sheet remains visually coherent: frame 27 contains no premature waveform, frame 76 shows the partial draw, frame 209 shows intermediate topology morphing, frame 241 preserves the shared evidence node through the transition, and frame 291 provides a restrained readability hold. No clipping or caption-safe-zone regression was visible.

## Strict assessment

This slice closes the browser random-access determinism gap for the one validated composition. It does not make the renderer production-ready.

Remaining risks:

- only one ten-second fixture has browser-level coverage;
- the 13.79% stasis result is still close to the 15% threshold;
- HyperFrames' internal capture page lacks first-class request telemetry;
- jerk, OCR readability, object persistence, and scene-boundary continuity are not yet strong release gates;
- 30–40 second pacing, human preference, retention, and profitability remain unproven.

The next justified slice is motion-integrity QA: decoded-frame jerk/continuity, OCR clipping/readability, and object-persistence evidence across multiple adversarial fixtures. Adding more visual templates before those gates would increase unmeasured failure surface.
