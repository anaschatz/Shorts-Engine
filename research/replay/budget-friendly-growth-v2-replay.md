# Budget Friendly Growth V2 Replay

- Policy: `bf-growth-replay-v1.0.0`
- Sources: 6
- Candidates: 95
- Human-approved positives: 18
- LLM calls: 0
- Renders: 0

## Aggregate

| Metric | Value |
| --- | ---: |
| V1 human-positive recall | 0.3889 |
| Positive-label interval match coverage | 0.9444 |
| Hook prompt evidence coverage | 0.0 |
| Semantic-closure acceptance rate | 0.2947 |
| Semantic-closure human-positive recall | 0.6111 |
| Full V2 acceptance rate | 0.0 |
| Full V2 human-positive recall | 0.0 |
| Closure-shadow top-3 precision (selected slots) | 0.7778 |
| Closure-shadow top-3 fill rate | 0.5 |
| Closure-shadow top-3 slot hit rate | 0.3889 |
| Closure-shadow full-batch source rate | 0.3333 |
| Potential closure false negatives | 7 |

## Acceptance gates

| Gate | Passed | Actual | Expected |
| --- | --- | ---: | --- |
| `SOURCE_COVERAGE` | yes | 6 | >=5 sources |
| `CANDIDATE_COVERAGE` | yes | 95 | >=30 candidates |
| `HUMAN_POSITIVE_COVERAGE` | yes | 18 | >=12 human-approved positives |
| `POSITIVE_LABEL_MATCH_COVERAGE` | yes | 0.9444 | >=0.90 |
| `HOOK_PROMPT_EVIDENCE_COVERAGE` | no | 0.0 | >=0.80 |
| `CLOSURE_HUMAN_POSITIVE_RECALL` | no | 0.6111 | >=0.80 |
| `CLOSURE_SHADOW_TOP_K_PRECISION` | yes | 0.7778 | >=0.60 |
| `CLOSURE_SHADOW_TOP_K_FILL_RATE` | no | 0.5 | >=0.80 |

## Source results

| Source | Candidates | Positives | Hook coverage | Closure acceptance | Closure positive recall | Shadow precision | Shadow fill |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `AyiWKXTd9aY` | 9 | 3 | 0.0 | 0.3333 | 0.3333 | None | 0.0 |
| `Jk9uJRMvBIA` | 13 | 3 | 0.0 | 0.2308 | 0.6667 | None | 0.0 |
| `VSG9hY_t-rs` | 17 | 3 | 0.0 | 0.2941 | 1.0 | 1.0 | 1.0 |
| `HwmwyBgzj8c` | 24 | 3 | 0.0 | 0.3333 | 0.3333 | 0.5 | 0.6667 |
| `aivpDPCP7Q8` | 16 | 3 | 0.0 | 0.25 | 0.6667 | 1.0 | 0.3333 |
| `LAmGfokvgzA` | 16 | 3 | 0.0 | 0.3125 | 0.6667 | 0.6667 | 1.0 |

## Potential closure false negatives

- `AyiWKXTd9aY` — **Turn Pain Into Power**: closure_required_continuation_missing, closure_model_incomplete_ending
- `AyiWKXTd9aY` — **What Actually Matters in Life**: closure_long_clip_requires_strong_evidence
- `Jk9uJRMvBIA` — **I Don't Follow Records**: closure_required_continuation_missing, closure_model_incomplete_ending, closure_second_topic_inside_interval
- `HwmwyBgzj8c` — **Your Emotions Are Lying to You**: closure_long_clip_requires_strong_evidence
- `HwmwyBgzj8c` — **Stop Selling AI. Sell the Outcome.**: closure_exact_quote_unaligned, closure_takeaway_boundary_unaligned
- `aivpDPCP7Q8` — **Seeing Life With Your Brain**: closure_long_clip_requires_strong_evidence
- `LAmGfokvgzA` — **The 'I' Monster**: closure_required_continuation_missing, closure_model_incomplete_ending

## Limitations

- Legacy candidates predate HookGateV2 prompt evidence. Full V2 acceptance is therefore a coverage result, not a hook-quality estimate; no evidence was synthesized.

## Recommendation

Keep `bf_growth_v2` in shadow/opt-in mode until every acceptance gate passes.
