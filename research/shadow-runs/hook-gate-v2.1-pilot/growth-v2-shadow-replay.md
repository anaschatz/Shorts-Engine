# Budget Friendly Growth V2 Replay

- Policy: `bf-growth-replay-v1.0.0`
- Sources: 1
- Candidates: 14
- Human-approved positives: 3
- LLM calls: 0
- Renders: 0

## Aggregate

| Metric | Value |
| --- | ---: |
| V1 human-positive recall | 0.0 |
| Positive-label interval match coverage | 0.0 |
| Hook prompt evidence coverage | 1.0 |
| Semantic-closure acceptance rate | 0.6429 |
| Semantic-closure human-positive recall | 0.0 |
| Full V2 acceptance rate | 0.0714 |
| Full V2 human-positive recall | 0.0 |
| Closure-shadow top-3 precision (selected slots) | 0.0 |
| Closure-shadow top-3 fill rate | 1.0 |
| Closure-shadow top-3 slot hit rate | 0.0 |
| Closure-shadow full-batch source rate | 1.0 |
| Potential closure false negatives | 3 |

## Acceptance gates

| Gate | Passed | Actual | Expected |
| --- | --- | ---: | --- |
| `SOURCE_COVERAGE` | no | 1 | >=5 sources |
| `CANDIDATE_COVERAGE` | no | 14 | >=30 candidates |
| `HUMAN_POSITIVE_COVERAGE` | no | 3 | >=12 human-approved positives |
| `POSITIVE_LABEL_MATCH_COVERAGE` | no | 0.0 | >=0.90 |
| `HOOK_PROMPT_EVIDENCE_COVERAGE` | yes | 1.0 | >=0.80 |
| `CLOSURE_HUMAN_POSITIVE_RECALL` | no | 0.0 | >=0.80 |
| `CLOSURE_SHADOW_TOP_K_PRECISION` | no | 0.0 | >=0.60 |
| `CLOSURE_SHADOW_TOP_K_FILL_RATE` | yes | 1.0 | >=0.80 |

## Source results

| Source | Candidates | Positives | Hook coverage | Closure acceptance | Closure positive recall | Shadow precision | Shadow fill |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `VSG9hY_t-rs` | 14 | 3 | 1.0 | 0.6429 | 0.0 | 0.0 | 1.0 |

## Potential closure false negatives

- `VSG9hY_t-rs` — **The Hardest Part of Love**: human_positive_interval_not_discovered
- `VSG9hY_t-rs` — **The Truth About Cynicism**: human_positive_interval_not_discovered
- `VSG9hY_t-rs` — **The Unique Power of Friendship**: human_positive_interval_not_discovered

## Recommendation

Keep `bf_growth_v2` in shadow/opt-in mode until every acceptance gate passes.
