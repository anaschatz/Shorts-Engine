# Prompt 01 — HookGateV2

Version: `hook-gate-v2.1.0`

Runtime integration:

- This prompt is injected only for `motivational_tension_micro_v2`.
- It does not add an LLM request.
- The model supplies semantic evidence; Python verifies words, timing, and final
  eligibility.
- The current v1 production profile remains unchanged for rollback.

## Production Prompt

```text
HOOK GATE V2 — version hook-gate-v2.1.0

Mission:
- Select spoken openings that make a new viewer understand why to keep watching
  before the surrounding interview context is known.
- Judge the spoken opening itself. A title, famous speaker, caption overlay, or
  later explanation may not rescue a weak first line.
- Python will verify exact words and timing after the response. Never estimate
  timestamps by inventing or paraphrasing speech.

Passing evidence:
- Choose hook_signal_phrase FIRST. Then set speech_start_time to the timestamp
  of its first word. Do not preserve an earlier lead-in, setup, or weaker
  version of the thought.
- opening_exact_quote is the exact first 4-12 consecutive source words at
  speech_start_time. Its first word must also be the first word of
  hook_signal_phrase.
- The base hook_sentence field must begin with the same hook_signal_phrase and
  the same first selected word; it may not restore an earlier setup.
- hook_signal_phrase is the earliest shortest exact 1-8 consecutive source
  words that identify a concrete subject plus a tension, reversal, rule,
  outcome, or consequence. It MUST be a prefix of opening_exact_quote and its
  final word MUST land within 1.0 seconds of speech_start_time. Return an empty
  string when no such opening signal exists.
- hook_payoff_phrase is the earliest exact 3-12 spoken words that make the
  tension, contradiction, rule, identity stake, outcome, or consequence clear.
- The verified hook payoff must land within 3.0 seconds of speech_start_time.
- Before returning a candidate, calculate
  speech_end_time - speech_start_time from the supplied timestamps. It must be
  8.0-30.0 seconds. Prefer one complete point in 15-21 seconds.
- A new viewer must understand the subject and the stakes without earlier dialogue.
- Prefer one of: contradiction, identity_stakes, concrete_rule,
  specific_consequence, or outcome_first.

first_second_value_score rubric:
- 0-24: filler, attribution, greeting, or context with no standalone value.
- 25-49: the topic is visible, but the tension or stakes are still missing.
- 50-69: a meaningful subject or tension begins, but is vague or incomplete.
- 70-84: a specific hook signal is already legible in the opening second.
- 85-100: an immediate, standalone signal makes both subject and stakes clear.
This score is advisory. Python will align hook_signal_phrase to exact word
timestamps and calculate the real latency.

Mandatory pass self-check:
- hook_signal_phrase starts on the exact first selected word;
- hook_signal_phrase ends no later than 1.0 seconds after speech_start_time;
- hook_payoff_phrase ends no later than 3.0 seconds after speech_start_time;
- speech duration is no longer than 30.0 seconds;
- the exact closing quote completes the point without a following required
  answer, consequence, correction, or referential completion.
If any check fails, move speech_start_time to a later self-contained hook or do
not return the candidate. Never mark it pass because the title sounds strong.

Recommend rejection when:
- The opening begins with detachable context such as "and", "but", "so",
  "that's when", "as I said", "coming back to", or an equivalent callback.
- "This", "that", "it", "he", "she", "they", or another reference has no
  antecedent inside the selected interval.
- The interval begins with a host question, greeting, attribution, speaker
  introduction, book reference, or throat-clearing.
- The first hook signal ends after 1.0 second or its payoff ends after 3.0
  seconds.
- The claim is generic motivation without a specific tension, mechanism,
  consequence, distinction, or actionable rule.
- The clip only becomes interesting after reading the generated title.

Required HookGateV2 fields on every returned motivational micro candidate:
- opening_exact_quote: exact consecutive spoken words.
- hook_signal_phrase: exact consecutive spoken words, or an empty string.
- hook_family: contradiction | identity_stakes | concrete_rule |
  specific_consequence | outcome_first | none.
- new_viewer_understands_opening: boolean.
- opens_with_context_connector: boolean.
- contains_external_antecedent: boolean.
- contains_host_setup: boolean.
- first_second_value_score: integer 0-100.
- specificity_score: integer 0-100.
- relatability_score: integer 0-100.
- stop_scroll_score: integer 0-100.
- hook_gate_recommendation: pass | reject | review.
- hook_gate_reasons: 1-8 declared reason codes.

Allowed positive reason codes:
- self_contained
- immediate_payoff
- concrete_stakes
- clear_contradiction
- identity_stakes
- actionable_rule
- relatable_consequence

Allowed negative reason codes:
- context_connector
- external_antecedent
- host_setup
- attribution_lead_in
- slow_payoff
- generic_motivation
- weak_specificity
- weak_relatability
- no_clear_tension
- transcript_evidence_missing

Use "review" only when the transcript evidence is genuinely ambiguous. Be
conservative: false positives waste a render and an upload; returning fewer
qualified candidates is better than padding the response.

Input:
Content type: {content_type}
Selection profile: motivational_tension_micro_v2
Requested candidate limit: {candidate_limit}

Timed transcript:
{timed_transcript}

Return valid JSON only. Add the required HookGateV2 fields to every object in
the existing top-level "highlights" array. Do not return markdown or commentary.
```

The runtime appends this authoritative extension after the shared base response
schema, so an unstructured backend sees one unambiguous final contract:

```text
HOOK GATE V2 AUTHORITATIVE FINAL RESPONSE EXTENSION:
The final output remains the existing top-level "highlights" array. Every
highlight object MUST contain all base fields plus every key in this fragment:
{"opening_exact_quote":"string","hook_signal_phrase":"string","hook_family":"contradiction|identity_stakes|concrete_rule|specific_consequence|outcome_first|none","new_viewer_understands_opening":bool,"opens_with_context_connector":bool,"contains_external_antecedent":bool,"contains_host_setup":bool,"first_second_value_score":int,"specificity_score":int,"relatability_score":int,"stop_scroll_score":int,"hook_gate_recommendation":"pass|reject|review","hook_gate_reasons":["reason_code"]}
Do not omit these keys and do not return a second array.
```

## Expected Candidate Fragment

```json
{
  "opening_exact_quote": "Do less than you think you can do.",
  "hook_signal_phrase": "Do less",
  "hook_payoff_phrase": "Do less than you think",
  "hook_family": "contradiction",
  "new_viewer_understands_opening": true,
  "opens_with_context_connector": false,
  "contains_external_antecedent": false,
  "contains_host_setup": false,
  "first_second_value_score": 88,
  "specificity_score": 92,
  "relatability_score": 85,
  "stop_scroll_score": 94,
  "hook_gate_recommendation": "pass",
  "hook_gate_reasons": [
    "self_contained",
    "clear_contradiction",
    "immediate_payoff"
  ]
}
```

## Decision Boundary

The response is not a publication decision.

The deterministic Python decision contract requires the engine to:

1. align `opening_exact_quote`;
2. align `hook_signal_phrase` and calculate its actual latency;
3. align `hook_payoff_phrase`;
4. calculate actual hook-payoff latency;
5. inspect the real opening words for connectors/context;
6. reject when deterministic evidence contradicts the model;
7. pass the surviving candidate to semantic-closure validation.

## Implemented Deterministic Decision

Runtime version: `hook-gate-decision-v1.1.0`

The engine now performs all seven steps above after motivational word
alignment. Matching is exact, consecutive, and restricted to the selected
speech interval:

- `hook_signal_phrase` targets `1.000s`; exact caption timing receives a
  bounded 50ms measurement tolerance;
- `hook_payoff_phrase` must end by `3.000s`;
- `1.051s` and `3.001s` fail their respective gates;
- missing exact word timing returns `review`;
- hallucinated, paraphrased, or out-of-interval phrases are rejected;
- connector, external-pronoun, host-setup, attribution, and previous-context
  openings are rejected;
- a self-contained high-stakes question is not rejected merely for being a
  question.

The model recommendation remains evidence, not authority. The V2 ranker only
accepts `hook_gate_status=pass` with the current decision version.
