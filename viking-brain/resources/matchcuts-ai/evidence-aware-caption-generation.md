# Evidence-Aware Caption Generation

Milestone: Evidence-Aware Caption Generation + Human Feedback Quality Loop.

Purpose:
- Move caption generation behind `server/caption-generation.cjs` and `server/adapters/caption-provider-adapter.cjs`.
- Keep local/demo/eval deterministic with no API keys and no network.
- Make captions more specific to football evidence without fabricating goals.
- Add a human review feedback summary loop that is local-only and safe.

Contracts:
- Captions must include `start`, `end`, `text`, `role`, `emphasis`, `layout`, `captionIntent`, `captionSource`, `captionEvidence` and `captionRiskFlags`.
- `captionEvidence.alignedHighlightType` must match the selected edit-plan highlight type.
- `goal_language_without_evidence` is fail-closed and rejected before render.
- Crowd/audio reaction is support copy when action evidence is stronger; it is primary only for reaction-only moments.
- Weak/uncertain evidence uses neutral pressure/developing-play copy.
- Provider failures fall back to deterministic captions with safe warning codes and no raw provider output.

Quality loop:
- `npm run eval` tracks:
  - `captionSpecificityScore`
  - `reactionAsSupportScore`
  - `weakEvidenceNeutralityScore`
  - `providerFallbackRate`
- `npm run eval:reference` adds the same caption quality guardrails to reference-style review.
- `npm run feedback:summary` reads `eval/human-feedback/` and writes safe aggregate review reports without mutating training data.

Safety:
- No paid provider is required by default.
- No provider raw errors, local paths, storage keys or tokens should appear in reports/API output.
- Reports should use safe opaque refs instead of absolute file paths.

