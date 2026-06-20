# Counted Goals Only Truth Gate Session

Date: 2026-06-20

## Decisions

- Added a stricter public truth contract for valid, disallowed and unknown goal candidates.
- Added a synthetic counted-goals-only fixture with two disallowed/offside candidates and two late counted goals.
- Updated evaluation scoring so valid-goals-only fixtures score the final confirmed-goal compilation plan and require exact counted-goal segment count/order.
- Kept fallback providers and local deterministic evaluation as default; no API keys or network are required for eval/tests.

## Safety

- Valid-goals-only output must not fall back to big chances, reactions, hymns or celebration-only moments.
- Disallowed/offside events expose safe disqualifiers and remain excluded from final output.
- Public report summaries avoid raw local paths, secrets, storage keys, provider raw errors and logs.

## Verification

- Focused tests cover public valid/disallowed truth output and counted-goals-only evaluation behavior.
- Full local validation must include lint, build, test, eval, reference eval, demo smoke/browser checks, CI report validation and release check before commit/push.
