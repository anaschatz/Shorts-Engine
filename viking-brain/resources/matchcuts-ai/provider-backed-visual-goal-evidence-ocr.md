# Provider-Backed Visual Goal Evidence + OCR Confirmation Layer

## Boundary
- `server/goal-evidence-provider.cjs` owns the visual goal evidence contract.
- The default provider is deterministic and local; external providers must sit behind the adapter contract and are never required for tests, eval, or local demo.
- OCR evidence is accepted as bounded structured metadata (`scoreBefore`, `scoreAfter`, `timestamp`, confidence, temporal consistency), not as raw provider logs.

## Safety Rules
- A valid goal requires ball-in-net/line-cross context plus strong confirmation such as scoreboard OCR score change, referee goal signal, kickoff-after-goal, replay+score confirmation, or explicit commentary with visual confirmation.
- Crowd reaction, commentary spike, goal-area context, or celebration footage alone cannot create a goal claim.
- Ambiguous OCR, unchanged score, offside flag, VAR/no-goal, or scoreboard goal removal fail closed to non-valid goal outcomes.
- `celebration_only` and `anthem_or_intro` are explicit non-goal outcomes for valid-goals-only mode.

## Metrics
- Eval now tracks `goalEvidenceCoverage`, `celebrationOnlyExclusion`, and `anthemIntroExclusion`.
- The OCR fixture proves three valid goals can be confirmed from ball-in-net plus scoreboard OCR score changes without pre-baked `scoreboard_goal_confirmed` visual labels.

## Observability
- Render logs include bounded counters for OCR evidence, scoreboard-confirmed goals, ambiguous OCR, celebration-only, and anthem/intro evidence.
- Public reports expose safe counts and normalized OCR status only; no raw OCR dumps, paths, storage keys, stderr/stdout, tokens, or provider errors.
