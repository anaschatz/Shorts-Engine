# Evidence-Aware Caption Generation Session

Date: 2026-06-17.

Decisions:
- Added a dedicated caption generation boundary with deterministic default output.
- Added a caption provider adapter contract for future LLM captions while keeping local fallback no-network and no-key.
- Kept goal language fail-closed unless explicit goal evidence is present.
- Added eval/reference metrics for caption specificity, reaction-as-support, weak-evidence neutrality and provider fallback rate.
- Added a local human feedback summary format and runner.

Validation target:
- Run lint, build, tests, eval, reference review, feedback summary, brain health, CI report validation, release check and demo smokes before commit/push.

Validation results:
- `npm run eval`: passed, aggregate score 98, 18 fixtures.
- `npm run eval:reference`: passed, aggregate score 95, 8 fixtures.
- `npm run feedback:summary`: passed, one local example feedback item, no training data mutation.
- Local lint/build/tests/demo/release checks passed before commit.

Limitations:
- Real LLM caption generation remains disabled by default.
- Human feedback summary aggregates local review files but does not automatically update training data.
- Reference `captionActionAlignment` remains a useful signal at 0.75 even though specificity/support/neutrality are 1; replay/commentary wording is the next product target.
