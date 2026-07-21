# Dark Curiosity Motion-Integrity QA

Status: Slice E1 implemented in shadow mode; production thresholds not approved

Date: 2026-07-21

## What this slice measures

The renderer QA decodes every frame in the semantic visual region as grayscale
pixels. For each consecutive frame it derives normalized luma velocity,
acceleration, and jerk. It reports mean, P90, P99, and peak temporal values,
while declared readability holds are excluded from active-motion summaries.

Semantic-v3 renders are segmented by the exact `wordSpan` of every visual
sentence. At each sentence start, QA compares the transition energy with the
local median motion energy and records a boundary jump ratio. The older
scene-level segmentation remains unchanged for non-semantic profiles.

The browser proof independently inspects visible procedural geometry at its
audited seek checkpoints. Every observed bounded-geometry root and visible node
must remain inside the semantic ROI and outside the caption safe zone, and
every expected sentence must be observed at least once. This catches failures
such as a chart marker or graph node drifting out of its intended visual area
at an audited frame even when the surrounding SVG remains valid. It does not
yet prove continuous bounds between checkpoints.

## Metric definitions

For grayscale pixel value `p[t]`:

```text
velocity[t]     = p[t] - p[t-1]
acceleration[t] = velocity[t] - velocity[t-1]
jerk[t]         = acceleration[t] - acceleration[t-1]
```

Absolute acceleration is normalized by `510`; absolute jerk is normalized by
`1020`. Values are aggregated over the semantic ROI. These measurements are
deterministic temporal luma proxies. They are not OpenCV optical flow, do not
infer direction, and do not prove that a human understood the animation.

## Calibration contract

`motion-integrity-qa.cjs` emits a canonical, hash-bound, deeply frozen report.
It rejects unknown fields, paths, raw frames, sample hashes, accessors, symbols,
sparse arrays, polluted prototypes, duplicate IDs, non-finite values, and
inconsistent summaries.

The v1 profile is deliberately unable to set
`productionThresholdsApproved: true`. Its test corpus contains ten engineering
cases: three real source fixtures and seven synthetic/adversarial controls for
stasis, smooth motion, a hard boundary cut, one-frame flicker, overload,
caption collision, and node escape. Those ten cases validate the report and
failure behavior; they do not count as ten real stories.

The numeric values attached to the three real-source cases in the unit test are
deterministic contract fixtures, not captured render measurements. Here,
`sourceKind: real` identifies the story origin; it is not a provenance proof.
The benchmark adapter test uses generated grayscale frames and correctly marks
that case as synthetic. A production calibration dataset still needs hashes
bound to real QA artifacts and structural status derived from those artifacts.

Current calibration blocker:

```text
MOTION_CALIBRATION_REAL_FIXTURES_INSUFFICIENT
```

There are currently 32 semantic sentence cases across three real stories:

- Wow Signal: 9 sentences;
- GPS week rollover: 13 sentences;
- Baychimo: 10 sentences.

## Verification

Fast deterministic checks:

```bash
node --test \
  tests/dark-curiosity-animation-benchmark.test.cjs \
  tests/dark-curiosity-animation-browser-seek.test.mjs \
  tests/dark-curiosity-motion-integrity-qa.test.cjs
```

Real local Chromium proof, including all three source stories:

```bash
RUN_SEMANTIC_SCENE_ACTION_BROWSER_TEST=1 \
  node --test --test-timeout=120000 \
  tests/dark-curiosity-semantic-scene-actions-browser.test.cjs
```

The browser command is opt-in because it launches the locally installed Chrome
binary. It performs no external network request and uses only engine-owned
HTML/SVG.

The corrected 720×1280 benchmark command now runs that browser geometry proof
before accepting its FFmpeg motion report:

```bash
npm run dark-curiosity:animation:benchmark -- \
  --render --yes --width 720
```

The 2026-07-21 local proof decoded all 300 frames and passed the existing hard
QA gates. It recorded 279 active jerk transitions after readability-hold
exclusion, jerk P99 `0.012647382448124874`, peak jerk
`0.01359823487107896`, and one scene-boundary jump ratio
`1.1279256674638334`. These values prove that the real MP4 measurement path
works; they are one benchmark observation, not calibrated production limits.

## What remains before production gating

1. Add at least seven story-distinct real fixtures and collect decoded-render
   metrics, not merely synthetic controls.
2. Calibrate thresholds from distributions and human-reviewed failure labels;
   do not choose limits from the current three stories alone.
3. Add direction-aware optical-flow checks for camera and object motion.
4. Add OCR/readability evidence during low-motion holds.
5. Add explicit cross-sentence entity identity before claiming object
   persistence; sentence-local bounded geometry is not that proof.
6. Keep the gates in shadow mode until false-positive and false-negative rates
   are measured on the expanded corpus.
