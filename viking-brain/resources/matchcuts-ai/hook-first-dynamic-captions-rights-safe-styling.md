# Hook-First Dynamic Captions + Rights-Safe Styling

Milestone: Hook-First Editing + Dynamic Word Captions + Rights-Safe Creative Styling.

Production decision:

- Shorts must include an evidence-backed cold open in the first two seconds.
- Captions must carry word-level timing metadata so the ASS renderer can emit word-by-word dynamic caption beats.
- Render proof and eval reports must expose dynamic caption coverage, first-two-second hook status, caption readability, rights-safe audio policy and safe creative style status.
- Styling may use safe color grade, mild zoom and caption-safe overlays for polish, but must not use mirroring, watermark hiding, scorebug hiding or any copyright-evasion behavior.
- Audio defaults remain source/muted/licensed-local/platform-native placeholder only. Bundled copyrighted or "trending" tracks are rejected by validation.

Safety contracts:

- `validateEditPlan` normalizes `hookPlan`, dynamic caption metadata, `audioPolicy` and `creativeStyleTransforms`.
- `assertVideoOutputCoverage` fails final proof when hook/caption/audio/style contracts are missing or unsafe.
- Eval and reference review keep these metrics deterministic and local-only; no API keys, network or provider calls are required.

Known limitation:

- This does not add platform-native music selection. Platform-native/trending audio remains an operator upload-time action because bundling copyrighted audio by default is unsafe.
