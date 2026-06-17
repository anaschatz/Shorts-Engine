# Review Fix Suggestions + Regeneration Readiness

## Purpose

ShortsEngine review registration now turns failed or borderline review metrics into deterministic operator fix suggestions. This keeps the review loop actionable without enabling destructive or automatic regeneration.

## Suggestion Contract

Suggestion objects are flat, schema-validated records with:

- `id`
- `type`
- `severity`
- `target`
- `message`
- `reasonCode`
- `safeAction`
- `canAutoApply: false`
- `requiresHumanReview`
- `relatedMetric`
- `relatedFailureCode`

Supported suggestion types:

- `caption_rewrite`
- `caption_timing_adjustment`
- `framing_adjustment`
- `animation_cue_adjustment`
- `moment_reselection`
- `false_goal_guard`
- `evidence_strengthening`
- `aspect_ratio_fix`
- `reviewer_manual_check`

## Regeneration Readiness

- Automatic rendering is not available from review suggestions.
- After the controlled regeneration milestone, public responses can include `regenerationAvailable: true` only to mean a manual draft plan can be created.
- `regenerationPlan` is always `null`.
- Every suggestion defaults to `canAutoApply: false`.
- Blocking suggestions must be resolved with manual review before any future render step.

## Safety

- Clean passing reviews return an empty `suggestions` array.
- Failed metrics map to bounded safe messages and safe actions only.
- No absolute paths, storage keys, raw stdout/stderr, raw provider errors, logs, tokens or secrets are allowed in suggestions or reports.
- API logs include only counts and suggestion types, not raw suggestion messages.

## UI Contract

- The operator Review panel shows Fix suggestions only after registration and only when suggestions exist.
- Suggestions show severity, target, message and safe action.
- The regeneration control creates a draft only after operator action; rendering remains locked.
- The layout stays compact and mobile-safe with wrapping text and no horizontal overflow.

## Validation

- `tests/review-fix-suggestions.test.cjs` covers deterministic mapping, schema rejection and leak guards.
- Review registration tests cover clean-pass empty suggestions and failed-output blocking suggestions.
- Backend API tests cover safe public suggestion response.
- Demo/browser smoke includes suggestion summary and disabled regeneration contracts.
