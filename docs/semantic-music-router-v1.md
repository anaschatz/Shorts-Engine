# Semantic music router V1

`bf_feed_stop_format_v4` keeps the V3 visual, captions, HookGate V4,
SpokenClarity, DeliveryQuality, SpeechCleanliness, natural-tail and dynamic
envelope contracts. Its only new output axis is the licensed music selection.

## Decision flow

1. HookGate and the speech gates must pass.
2. The router reads the complete topic, opening claim, whole-point summary,
   payoff, takeaway, thesis and selected transcript text. Point and payoff
   carry more weight than the opening; there is no first-word rule.
3. It selects a semantic family and one exact entry from the sealed Pixabay
   catalog.
4. It excludes the previous four track IDs from the explicit oldest-to-newest
   public-and-scheduled publication ledger. Tracks chosen earlier in the same
   batch are reserved too.
5. The decision freezes the full semantic-input hash, catalog hash, track ID,
   treatment profile, exact start offset, rotation window and score evidence.
6. Before FFmpeg, the renderer independently verifies the decision, catalog,
   local byte length and SHA-256. It rejects legacy path/profile/start
   overrides for V4.
7. Render cache identity, RenderManifestEvidence and editorial QA bind the
   same decision and exact asset receipt.

## Runtime

Raw music files remain private because the Pixabay license does not allow
standalone redistribution. Install them from their recorded official URLs:

```bash
python3 scripts/install_music_catalog_assets.py
python3 scripts/install_music_catalog_assets.py --check
```

Generate with an explicit publication ledger when available:

```bash
python3 main.py SOURCE \
  --mode local \
  --format-profile bf_feed_stop_format_v4 \
  --recent-publications recent-publications.json
```

Without a ledger the semantic choice still works and a multi-Short batch does
not reuse tracks, but the engine records `rotation_history_short` and cannot
claim cross-upload repetition protection.

## Fail-closed cases

- missing or tampered catalog/asset;
- missing, stale or transplanted routing decision;
- decision track/profile/offset differs from catalog;
- runtime music override is set for V4;
- selection, renderer, cache or QA receipts disagree.

V1–V3 remain verifiable and unchanged. Any change to the catalog, semantic
scoring, rotation policy, allowed offsets or envelope requires a new version.
