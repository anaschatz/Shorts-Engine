# Budget Friendly R1 vs R2 comparison

Date: 2026-07-17  
Source: `VSG9hY_t-rs`  
Status: local production renders complete; no upload authorized

## Outputs

| Variant | Speaker | Hook family | Duration | Creative QA | Audio QA |
|---|---|---|---:|---|---|
| R1 — The Hardest Part of Love | Jay Shetty | Contradiction | 14.633s | Pass | Pass |
| R2 — The Truth About Cynicism | Andrew Huberman | Identity stakes / contrast | 18.000s | Pass | Pass |

R1 video:
`AI-Youtube-Shorts-Generator/output/production/bf-vsg9hyt-rs-2026-07-17-r1/render/short_01.mp4`

R2 video:
`AI-Youtube-Shorts-Generator/output/production/bf-vsg9hyt-rs-2026-07-17-r2/render/short_01.mp4`

## QA measurements

| Measurement | R1 | R2 |
|---|---:|---:|
| Resolution / FPS | 1080×1920 / 30 | 1080×1920 / 30 |
| First visible text | 0.10s | 0.10s |
| Maximum hero scale | 2.25× | 2.60× |
| Source cuts | 1 | 1 |
| Artificial cuts | 0 | 0 |
| Integrated loudness | -15.6 LUFS | -15.8 LUFS |
| True peak | -1.9 dBTP | -1.9 dBTP |
| Brand-tail RMS | -240 dBFS | -240 dBFS |
| Brand tail | 0.30s | 0.30s |

R1 output SHA-256:
`e6e64f652de1a85b7a6e1af272d2e6d3e0ca52392a765bd166916c64a11ad099`

R2 output SHA-256 after caption correction:
`df92d77dda2005e24c5489a8e85ba70a6057b2d58edb712dbb1ccfe200d098b0`

## Human visual review

- Both variants have clean grayscale grading, a stable rounded inset, readable kinetic captions, visible faces, and a clean BF tail.
- R1 has more visual energy from gestures and a natural source angle change.
- R2 is visually more static, but the cynicism-versus-discernment distinction is more concrete and authority-led.
- The R2 transcript was editorially corrected from `accept to separate` to `except to separate`; the corrected caption is present in the final render and sealed render timeline.

## Expected strengths

R1 is the stronger scroll-stop candidate:

- shorter duration;
- direct contradiction in the first sentence;
- payoff latency of 2.86s;
- higher measured visual action;
- broader relationship theme.

R2 is the stronger authority/save candidate:

- Andrew Huberman on screen;
- specific distinction between cynicism and discernment;
- stronger opportunity for thoughtful comments and saves;
- payoff latency is slower at 3.98s and the middle contains a small personal aside.

## Comparison protocol

This is a creative shootout, not a strict single-variable A/B test: the speaker, topic, duration, and hook family differ.

1. Publish only after source-rights evidence is available.
2. Use the same weekday and local posting time, ideally seven days apart.
3. Keep description structure, hashtags, audience settings, and related-video treatment fixed.
4. Compare equal-age snapshots at 1h, 6h, 24h, 72h, and 168h.
5. Use `stayed to watch` and equal-age engaged views as primary evidence.
6. Use average percentage viewed, shares/comments per 1,000 engaged views, and subscribers per 1,000 engaged views as secondary evidence.
7. Do not call a winner before 72h; prefer the 168h decision unless the reach difference is extreme.

Expected winner before live data: R1 for reach; R2 may outperform on saves/comments.

## Verification

- Full local test suite: 230 tests passed.
- Both production bundles contain sealed candidate, experiment, edit-plan, render, creative-QA, and audio-QA artifacts.
- No upload, publish-plan, or public release action was performed.
