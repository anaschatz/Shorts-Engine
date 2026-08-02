# Generalized Visual Engine — Step 6 Report — 2026-08-02

## Outcome

Step 6 adds a production-independent human-calibration system around the generalized visual renderer. The production dispatch remains unchanged and disabled for this path.

Implemented:

- Twelve operator-created rights-safe cases and 36 canonical scene compilations.
- At least three scenes for every registered recipe.
- Deterministic blinded assignment, strict response, and strict aggregate contracts.
- Silent and narrated review modes.
- No-free-text bounded rubric and issue taxonomy.
- Two-human-responses-per-scene evidence gate.
- Local Chromium pack with 36 animated previews and eight recipe contact sheets.
- Desktop 1080×1920 and mobile 390×844 browser verification.
- Loopback-only accessible review UI with local response persistence.
- Explicit operator finalize command.
- Sanitized content-hash-bound reports.

## Rendered findings and bounded refinements

The first rendered calibration pack exposed a harness defect: preview loops used nonexistent scene-level frame bounds and produced background-only contact sheets. The harness now derives bounds from canonical scene phases, pauses animation for deterministic screenshots, and fails if the primary visual is not actually visible.

Once valid images existed, agent visual inspection found:

1. `comparison` looked like an unlabeled chart and did not communicate two states.
2. `chronology` looked like a thin axis with repeated markers and no event hierarchy.
3. Helper copy lost hierarchy at reduced/mobile scale.
4. Contact sheets cropped vertical compositions when a grid cell had a different aspect ratio.

Only those evidenced weaknesses were changed:

- `comparison` now renders distinct BEFORE and AFTER state cards, an explicit transition arrow, different state magnitudes, and a state-change label.
- `chronology` now renders START, TURN, and NOW event cards, an ordered arrow, earlier/later anchors, and a dominant active endpoint.
- Helper copy increased from a requested 26 px across three lines to 30 px across at most two lines.
- Contact sheets use aspect-preserving containment.

Other recipes were not modified without human evidence.

The implementation agent's review is recorded separately from human evidence and uses only the bounded production rubric:

```json
{
  "agent_visual_review": {
    "performed": true,
    "humanEvidence": false,
    "rubric": {
      "narrationVisualCorrespondence": 4,
      "immediateComprehensibility": 4,
      "focalClarity": 4,
      "textLegibility": 4,
      "revealClarity": 4,
      "pacing": 4,
      "visualDistinctiveness": 4
    },
    "issueCodes": ["VISUAL_NARRATION_LINK_WEAK"]
  }
}
```

The remaining issue is bounded: generic state labels improve comparison readability, but only a real blinded reviewer can establish whether the visual-to-narration link is sufficient across the corpus.

## Automated evidence

The generated pack at the implementation baseline reported:

- 12 cases.
- 36 scenes and 36 animated previews.
- Eight recipe contact sheets.
- Zero external browser requests.
- Desktop and mobile animation gates passed.
- Keyboard interaction, silent-to-narrated transition, local persistence, ARIA, CSP, and network-isolation gates passed.
- `humanReviewStatus: pending`.
- `calibrationStatus: insufficient_evidence`.
- `humanApproved: false`.
- `productionReady: false`.

The report deliberately excludes local pack IDs, paths, filenames, narration, URLs, identifiers, and raw screenshots.

## Validation added

- Corpus compilation and coverage tests.
- Explicit handling of calibration-only unknown semantics.
- Seed determinism and public blinding tests.
- Contract exactness, immutability, hash binding, tamper rejection, bounded issue codes, and duplicate response rejection.
- Proof that mock data does not count as human evidence.
- Proof that complete two-session human-shaped evidence still requires final confirmation and never changes `productionReady`.
- Real Chromium pack integration at desktop and mobile bounds.
- Sanitized report mutation tests.

## Honest status

No real person completed the 36-item pack twice during implementation. Therefore no human calibration result exists and no quality claim beyond automated and agent visual evidence is valid. Production activation remains blocked by real blinded human review and the later production gate.
