# Budget Friendly pilot — VSG9hY_t-rs — 2026-07-17

Status: discovery complete; 3 candidates are eligible; no candidate has been
human-approved, rendered, or uploaded.

## Source

- Title: `Andrew Huberman's Hack To Increase Your Dopamine Levels & Boost Motivation By 60%`
- Publisher: `Jay Shetty Podcast`
- YouTube ID: `VSG9hY_t-rs`
- Duration: 6,357.32 seconds
- Source dimensions: 1920×1080 at 29.97 fps
- Source SHA-256: `bbe373b914383c4e9af47192cd85d0424b5ea5ecccbe1b8705acdbad29eadad1`
- Ranking manifest seal:
  `40e57d99d2291aba24bb9a67f6af0b80863f67cdc4ae9b85452e402dbd01e3f8`

The manifest seal was recomputed and verified locally.

## Discovery result

The `bf_viral_micro_v1` engine evaluated 17 candidates. Three passed every hard
gate. Rendering was skipped by `--select-only`.

| Rank | Candidate | Speech | Score | Tension | Contrast | Payoff | Source cuts |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | The Hardest Part of Love | 14.06s | 87.724 | 95 | 96 | 94 | 1 |
| 2 | The Truth About Cynicism | 17.22s | 85.200 | 90 | 92 | 90 | 1 |
| 3 | The Unique Power of Friendship | 20.98s | 79.658 | 90 | 92 | 91 | 1 |

## Human-review recommendation

### Recommend rank 1: The Hardest Part of Love

- Candidate hash:
  `fccbd8653c381bdc37e68378ea6651f1a093ff73bdd1215b270cc5a5883906d2`
- Source interval: 4263.56–4278.22
- Hook latency: 2.86 seconds
- Self-contained micro arc: 96
- Context dependence: 5
- Generic motivation: 10
- Face-visible sampled shots: 100%

Transcript:

> It's easy to love the good person. It's learning to love or understand at
> least the person who may have done something that you didn't recognize or
> didn't understand or didn't fully connect with.

This candidate best matches the reference direction: immediate human
contradiction, one idea, restrained duration, stable close-up, expressive hand
movement, and one genuine source camera change.

### Reserve: rank 2

`The Truth About Cynicism` has strong semantic contrast and visually usable
close-ups. It is held as a reserve because the sentence about the speaker's
sister briefly detours from the rule/payoff.

### Do not prioritize: rank 3

`The Unique Power of Friendship` is technically eligible but has the weakest
measured visual action and transitions into a wide two-person composition. Its
opening is also less compact than ranks 1 and 2.

## Runtime evidence

- Exact-word transcript: 1,580 segments covering 6,357 seconds.
- The engine wrote versioned JSON and SRT transcript caches.
- Long-source discovery used six structured-output chunks.
- A primary Gemini timeout correctly routed to the configured fallback.
- One schema-invalid model response was rejected and regenerated.
- Candidate visual analysis and genuine source-cut detection completed before
  ranking.

The local transcriber now supports opt-in ffmpeg waveform decoding through
`LOCAL_WHISPER_FFMPEG_DECODE=1`. This avoids PyAV media decoding while preserving
faster-whisper word timestamps. The new decode path is fail-closed and covered by
unit tests.

## Required next decision

Before production rendering:

1. A human must explicitly approve one candidate rank.
2. The experiment cohort and hypothesis must be declared.
3. Publication rights remain unresolved. A render may be produced for private
   review only after candidate approval, but no upload or release may proceed
   without owned/licensed/permission-granted evidence and exact attribution.

Recommended experiment declaration after approval:

- Cohort: `contradiction`
- Treatment: `love-good-vs-hard-v1`
- Primary variable: `hook_family`
- Hypothesis: A direct moral contradiction in the first sentence will improve
  viewed-vs-swiped-away and 3-second hold relative to generic motivational
  openings while keeping satisfaction signals stable.

