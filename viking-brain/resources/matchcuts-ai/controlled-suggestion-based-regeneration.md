# Controlled Suggestion-Based Regeneration

## Purpose

ShortsEngine can now convert review fix suggestions into a safe regeneration draft. The draft is a proposed edit plan only; it never starts rendering, never creates an export and never unlocks downloads.

## Contract

- `POST /api/review/regeneration-plan` reuses completed review registration records and rights confirmation.
- The route delegates to `server/regeneration-plan.cjs`.
- Every returned plan has `canRender: false` and `requiresHumanApproval: true`.
- Clean passing reviews return `status: not_needed`.
- Failed/borderline reviews can return `status: draft` with a validated `proposedEditPlan`.

## Suggestion Handling

- `false_goal_guard` removes unsupported goal language before validation.
- `caption_rewrite` and `evidence_strengthening` use evidence-aligned neutral wording.
- `caption_timing_adjustment` retimes captions within the selected clip duration.
- `framing_adjustment` forces wide-safe framing and full-frame preservation.
- `aspect_ratio_fix` enforces a vertical 9:16 export target.
- `animation_cue_adjustment` rebuilds animation cues from the allowed schema.
- `moment_reselection` and `reviewer_manual_check` are skipped into blocking/manual reasons.

## Safety

- No suggestion can auto-render.
- Proposed plans must pass `validateEditPlan`.
- Unsupported goal claims fail closed.
- API responses and logs must not expose storage keys, absolute paths, provider raw output, stdout/stderr, tokens or secrets.
- Logs include ids, counts and status only, not raw caption text.

## UI

- The Review panel shows a compact `Create draft` action only after a registered review with suggestions.
- Draft details summarize applied/manual/blocked suggestions and safe plan properties.
- Render/download controls remain governed by the original completed render flow and are not affected by draft creation.

## Validation

- `tests/regeneration-plan.test.cjs`
- `tests/backend.test.cjs`
- `tests/browser-demo.test.mjs`
- Existing review suggestion and registration tests continue to cover suggestion mapping and leak guards.
