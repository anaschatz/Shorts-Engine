# Generalized Visual Human Calibration V1

## Status and boundary

This workflow calibrates the generalized visual engine with blinded human review. It does not enable generalized visuals in the production render path. A generated pack starts with:

```json
{
  "humanReviewStatus": "pending",
  "calibrationStatus": "insufficient_evidence",
  "humanApproved": false,
  "productionReady": false
}
```

Automated tests, browser checks, screenshots, and agent visual inspection cannot replace human responses. Mock responses are excluded from human metrics and can never approve a calibration.

## Rights-safe corpus

`generalized-visual-calibration-corpus.cjs` creates twelve operator-authored synthetic cases. They are calibration constructs, not publishable factual stories. Every case passes through the canonical pipeline:

```text
DraftBundle → StoryIR → VisualProgram → VisualRecipePlan → AnimationIR
```

The corpus contains 36 scenes and covers all eight registered recipes at least three times. It includes verified, qualified, disputed, and explicitly unknown semantic situations. `unknown` remains calibration metadata; the current production StoryIR contract still maps its canonical certainty to `disputed`. Widening production certainty is deliberately outside this step.

## Blinded method

Assignment order and answer order are deterministic from a recorded SHA-256 seed. The strict assignment keeps recipe and composition metadata for aggregation, while the browser receives a reduced blinded view without recipe ID, case ID, story ID, source path, expected score, or raw narration.

Each anonymous item has two sequential modes:

1. `silent`: animation without narration context.
2. `narrated`: the same bounded animation with the relevant narration shown as caption context.

The reviewer chooses one of four bounded semantic relationships in each mode, then completes seven 1–5 scores (narration–visual correspondence, immediate comprehension, focal clarity, legibility, reveal clarity, pacing, and visual distinctiveness), six booleans, one bounded confusion choice, and up to eight allowlisted issue codes. The booleans explicitly record understanding without replay, narration dependency, primary-object identification, helper value, mobile readability, and manual-edit need. There is no free-text field.

Two distinct confirmed human sessions are required for every scene. Every recipe also requires at least three scenes. Anything below either boundary is `insufficient_evidence`; missing values are `null`, never zero.

## Metrics and approval rule

Per-recipe aggregation includes:

- Median narration correspondence, immediate comprehension, focal clarity, legibility, reveal clarity, pacing, and visual distinctiveness.
- Silent and narrated comprehension rates.
- Silent-to-narrated improvement rate.
- Primary-identification, understood-without-replay, narration-dependency, manual-edit, mobile-readability, and helper-value rates.
- Bounded issue-code frequencies.

Human approval requires complete two-reviewer coverage, explicit per-response confirmation, explicit final operator confirmation, no mock responses in the submitted set, median semantic/focal/legibility scores of at least 3, narrated comprehension of at least 0.70, and mobile readability of at least 0.70. Even then `productionReady` remains `false` in V1.

## Local security model

The pack is written under the operating-system temporary directory, outside Git. Files use anonymous hashes and restrictive modes. The report never contains narration, filenames, local paths, storage keys, URLs, tokens, or environment values.

The review server binds only to `127.0.0.1`, uses CSP and same-origin headers, permits only allowlisted pack files, limits JSON bodies, and writes each response with create-only semantics. Preview documents have `connect-src 'none'`; the review UI communicates only with its loopback server. No external network dependency is used.

Human provenance is an operator-controlled procedural boundary, not a biometric guarantee. Reviewers must not inspect assignment JSON or developer tools during the blinded task, and must use independent browser profiles or devices.

## How to run a real review

1. Validate without writes or browser launch:

   ```bash
   node tools/render-generalized-visual-calibration-pack.mjs --dry-run
   ```

2. Create the local pack:

   ```bash
   node tools/render-generalized-visual-calibration-pack.mjs --write --confirm-human-calibration
   ```

   Record the returned `packId`. This flag authorizes pack creation; it does not claim that human review occurred.

3. Start the loopback UI:

   ```bash
   node tools/serve-generalized-visual-calibration.mjs --pack calibration_<24-hex>
   ```

4. Open the returned local URL. Reviewer A completes all 36 items. Reviewer B repeats the full pack from a different browser profile or device so a distinct opaque session is created.

5. Only after both real reviewers finish, finalize:

   ```bash
   node tools/finalize-generalized-visual-calibration.mjs --pack calibration_<24-hex> --confirm-human-responses
   ```

6. Read the bounded JSON result. If coverage is incomplete, the result remains `insufficient_evidence` and `humanApproved:false`.

## Accessibility and review ergonomics

The UI supports keyboard focus, visible focus rings, ARIA labels and live status, Alt+Left/Alt+Right navigation, responsive 390×844 mobile layout, local resume, and explicit confirmation. The preview itself remains 1080×1920 and scales proportionally.

## Non-goals and known blockers

- No production dispatch change.
- No automatic interpretation of human intent.
- No free-form reviewer notes.
- No claim that the synthetic corpus predicts every future story family.
- No `unknown` production StoryIR verdict until its upstream evidence and publishing semantics are designed.
- No production activation until real human calibration, a separate production gate, and exact-commit staging proof exist.
