"use strict";

const SPECIALIZED_SEMANTIC_VISUAL_CONCEPT_BINDINGS = deepFreeze({
  bounded_value_range: binding({
    rendererVariant: "bounded_value_range",
    grammarIds: ["finite_cycle"],
    assetIds: ["finite_counter"],
    stateTransitions: ["reach_capacity"],
    stateTokens: ["LIMIT"],
  }),
  counter_capacity_comparison: binding({
    rendererVariant: "counter_capacity_comparison",
    grammarIds: ["side_by_side_comparison"],
    assetIds: ["finite_counter"],
    stateTransitions: ["compare_states"],
    stateTokens: ["COMPARED"],
  }),
  counter_date_misinterpretation: binding({
    rendererVariant: "counter_date_misinterpretation",
    grammarIds: ["cause_effect_chain"],
    assetIds: ["calendar_card", "receiver_device"],
    stateTransitions: ["map_to_incorrect_output"],
    stateTokens: ["WRONG"],
  }),
  counter_mapping_mechanism: binding({
    rendererVariant: "counter_mapping_mechanism",
    grammarIds: ["cause_effect_chain"],
    assetIds: ["mapping_table"],
    stateTransitions: ["map_input_to_output"],
    stateTokens: ["RESULT"],
  }),
  counter_not_time: binding({
    rendererVariant: "counter_not_time",
    grammarIds: ["side_by_side_comparison"],
    assetIds: ["hypothesis_card"],
    stateTransitions: ["reject_hypothesis"],
    stateTokens: ["REJECTED"],
  }),
  encoded_bit_register: binding({
    rendererVariant: "encoded_bit_register",
    grammarIds: ["cause_effect_chain"],
    assetIds: ["mapping_table"],
    stateTransitions: ["reveal_structure"],
    stateTokens: ["OBSERVED"],
  }),
  finite_counter_wrap: binding({
    rendererVariant: "finite_counter_wrap",
    grammarIds: ["finite_cycle"],
    assetIds: ["finite_counter"],
    stateTransitions: ["repeat_cycle"],
    stateTokens: ["REPEATS"],
  }),
  receiver_patch_required: binding({
    rendererVariant: "receiver_patch_required",
    grammarIds: ["cause_effect_chain"],
    assetIds: ["receiver_device"],
    stateTransitions: ["require_update"],
    stateTokens: ["UPDATE REQUIRED"],
  }),
});

const UPCOMING_SEMANTIC_VISUAL_CONCEPT_IDS = Object.freeze([
  "future_event_timeline",
  "future_rollover_timeline",
]);

const SAFE_NEUTRAL_CUE_VISUAL_CONCEPT_IDS = Object.freeze([
  "cue_evidence_focus",
  "cue_evidence_spotlight",
  "cue_evidence_field",
  "cue_evidence_ribbon",
  "cue_evidence_frame",
  "cue_evidence_bands",
]);

const GROUNDED_NEUTRAL_CUE_VISUAL_CONCEPT_IDS = Object.freeze([
  "cue_evidence_document",
  "cue_evidence_network",
  "cue_evidence_quote",
]);

const NEUTRAL_CUE_VISUAL_CONCEPT_IDS = Object.freeze([
  ...SAFE_NEUTRAL_CUE_VISUAL_CONCEPT_IDS,
  ...GROUNDED_NEUTRAL_CUE_VISUAL_CONCEPT_IDS,
]);

const NEUTRAL_SEMANTIC_VISUAL_CONCEPT_BINDINGS = deepFreeze(
  Object.fromEntries(NEUTRAL_CUE_VISUAL_CONCEPT_IDS.map(
    (visualConceptId) => [visualConceptId, binding({
      rendererVariant: visualConceptId,
      grammarIds: ["evidence_inspection"],
      assetIds: ["archive_record"],
      stateTransitions: ["become_visible"],
      stateTokens: ["RECORDED"],
    })],
  )),
);

function binding(input) {
  return {
    rendererVariant: input.rendererVariant,
    grammarIds: [...input.grammarIds],
    assetIds: [...input.assetIds],
    stateTransitions: [...input.stateTransitions],
    stateTokens: [...input.stateTokens],
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function semanticVisualConceptBinding(visualConceptId) {
  if (typeof visualConceptId !== "string") return null;
  if (Object.hasOwn(
    SPECIALIZED_SEMANTIC_VISUAL_CONCEPT_BINDINGS,
    visualConceptId,
  )) return SPECIALIZED_SEMANTIC_VISUAL_CONCEPT_BINDINGS[visualConceptId];
  return Object.hasOwn(
    NEUTRAL_SEMANTIC_VISUAL_CONCEPT_BINDINGS,
    visualConceptId,
  )
    ? NEUTRAL_SEMANTIC_VISUAL_CONCEPT_BINDINGS[visualConceptId]
    : null;
}

function semanticVisualConceptBindingMatches(input = {}) {
  const conceptBinding = semanticVisualConceptBinding(input.visualConceptId);
  if (!conceptBinding) return true;
  const matches = conceptBinding.grammarIds.includes(input.grammarId)
    && conceptBinding.assetIds.includes(input.assetId)
    && (
      input.stateTransition === undefined
      || input.stateTransition === null
      || conceptBinding.stateTransitions.includes(input.stateTransition)
    );
  if (!matches) return false;
  return input.stateToken === undefined
    || input.stateToken === null
    || conceptBinding.stateTokens.includes(input.stateToken);
}

function semanticVisualConceptTransitionMatches(
  visualConceptId,
  stateTransition,
) {
  const conceptBinding = semanticVisualConceptBinding(visualConceptId);
  return !conceptBinding
    || conceptBinding.stateTransitions.includes(stateTransition);
}

function semanticTemporalErrorKind(detailValue) {
  const context = typeof detailValue === "string"
    ? detailValue.toLocaleLowerCase("en-US")
    : "";
  if (
    /\bclocks?\b.{0,24}\bhaunted\b|\bhaunted\b.{0,24}\bclocks?\b/.test(
      context,
    )
  ) return "clock_anomaly";
  if (
    /\b(?:wrong|incorrect)\s+dates?\b/.test(context)
    || /\bdates?\b.{0,24}\b(?:wrong|incorrect(?:ly)?)\b/.test(context)
  ) return "date_error";
  if (
    /\b(?:wrong|incorrect|impossible)\s+(?:clocks?|time)\b/.test(context)
    || /\b(?:clocks?|time)\b.{0,24}\b(?:wrong|incorrect(?:ly)?|impossible)\b/.test(
      context,
    )
  ) return "time_error";
  return null;
}

function semanticNeutralDocumentCueMatches(detailValue) {
  const context = typeof detailValue === "string"
    ? detailValue.toLocaleLowerCase("en-US")
    : "";
  return /\b(?:archive|article|document|journal|ledger|newspaper|report)\b/.test(
    context,
  )
    || /\b(?:archive|case|data|digital|source)\s+file\b/.test(context)
    || /\b(?:instruction|operator|receiver|repair|service|technical|user)\s+manual\b/.test(
      context,
    )
    || /\bmanual\s+(?:document|entry|listed|mentioned|page|said|showed|stated)\b/.test(
      context,
    )
    || /\b(?:archival|company|digital|historical|official|written)\s+(?:log|note|paper|record)\b/.test(
      context,
    )
    || /\b(?:log|note|record)\s+(?:entry|file|listed|read|said|showed|stated)\b/.test(
      context,
    )
    || /\b(?:documented|logged|recorded)\b/.test(context);
}

function semanticNeutralNetworkCueMatches(detailValue) {
  const context = typeof detailValue === "string"
    ? detailValue.toLocaleLowerCase("en-US")
    : "";
  return /\b(?:connect(?:ed|ion|ions|s|ing)?|link(?:ed|s|ing)?|network|relationship|relationships)\b/.test(
    context,
  )
    || /\bbeam\b.{0,24}\bcross(?:ed|es|ing)?\b/.test(context)
    || /\btransmit(?:s|ted|ting)?\b.{0,32}\b(?:from|into|through|to)\b/.test(
      context,
    )
    || /\b(?:mapped|maps|mapping)\b.{0,32}\b(?:as|into|to)\b/.test(
      context,
    );
}

function semanticNeutralQuoteCueMatches(detailValue) {
  const context = typeof detailValue === "string"
    ? detailValue.toLocaleLowerCase("en-US")
    : "";
  return /["“”][^"“”]{1,120}["“”]/.test(String(detailValue || ""))
    || /\b(?:asked|called|claimed|named|quoted|replied|said|says|told|wrote|writes)\b[^.!?]{0,48}\b(?:answer|message|name|phrase|reply|word)\b[^.!?]{0,20}:/.test(
      context,
    );
}

function groundedNeutralCueVisualConceptIds(detailValue) {
  const candidates = [];
  if (semanticNeutralDocumentCueMatches(detailValue)) {
    candidates.push("cue_evidence_document");
  }
  if (semanticNeutralNetworkCueMatches(detailValue)) {
    candidates.push("cue_evidence_network");
  }
  if (semanticNeutralQuoteCueMatches(detailValue)) {
    candidates.push("cue_evidence_quote");
  }
  return Object.freeze(candidates);
}

function sameGroundedSource(left, right) {
  return left && right
    && left.sourceType === right.sourceType
    && left.sourceId === right.sourceId
    && left.operationIndex === right.operationIndex
    && left.field === right.field;
}

function groundedFragmentMatchesDetail(detailValue, detailSourceRef, fragment) {
  if (
    typeof detailValue !== "string"
    || !detailSourceRef
    || !fragment
    || typeof fragment.value !== "string"
    || !sameGroundedSource(detailSourceRef, fragment.sourceRef)
  ) return false;
  const start = fragment.sourceRef.startOffset - detailSourceRef.startOffset;
  const end = fragment.sourceRef.endOffset - detailSourceRef.startOffset;
  return Number.isSafeInteger(start)
    && Number.isSafeInteger(end)
    && start >= 0
    && end > start
    && end <= detailValue.length
    && fragment.sourceRef.endOffset <= detailSourceRef.endOffset
    && detailValue.slice(start, end) === fragment.value
    && fragment.sourceRef.value === fragment.value;
}

function groundedQuantityMatchesDetail(input = {}) {
  if (input.quantity === null || input.quantity === undefined) return true;
  const quantity = input.quantity;
  if (!groundedFragmentMatchesDetail(
    input.detailValue,
    input.detailSourceRef,
    {
      value: quantity.value,
      sourceRef: quantity.valueSourceRef,
    },
  )) return false;
  if (quantity.unit === null) return quantity.unitSourceRef === null;
  return groundedFragmentMatchesDetail(
    input.detailValue,
    input.detailSourceRef,
    {
      value: quantity.unit,
      sourceRef: quantity.unitSourceRef,
    },
  );
}

function hasOppositeClaimCue(context) {
  return /\b(?:cannot|never|neither|no|nor|not|without|[a-z]+n['’]t|fail(?:s|ed|ing)?\s+to|lack(?:s|ed|ing)?|unable\s+to)\b/.test(
    context,
  );
}

function semanticFiniteCounterWrapClaimMatches(detailValue) {
  const context = typeof detailValue === "string"
    ? detailValue.toLocaleLowerCase("en-US")
    : "";
  if (
    /\b(?:counter|week\s+(?:counter|number))\b.{0,32}\b(?:remained|stayed)\s+(?:fixed|unchanged)\b/.test(
      context,
    )
  ) return false;
  if (/\b(?:rover|vehicle)\b.{0,24}\broll(?:ed|s)?\s+over\b/.test(context)) {
    return false;
  }
  const counterSubject = "(?:(?:gps|legacy|newer)\\s+)*(?:week\\s+)?counter";
  const auxiliary = "(?:(?:will|would|has|had|did|does)\\s+)?";
  const selfReset = "reset(?:s|ting)?(?:\\s+(?:itself|again)|\\s+to\\s+(?:zero|0))?(?=$|[,.;!?]|\\s+(?:after|when|while|and|but)\\b)";
  const selfWrap = "(?:roll(?:ed|s)?\\s+over|wrap(?:s|ped|ping)?(?:\\s+to\\s+(?:zero|0))?)(?=$|[,.;!?]|\\s+(?:again|after|when|while|and|but|in|by)\\b)";
  return new RegExp(
    `\\b${counterSubject}\\b\\s+${auxiliary}(?:${selfReset}|${selfWrap})`,
  ).test(context)
    || /^\s*(?:the\s+)?(?:number|value)\s+(?:reset(?:s|ting)?|wrap(?:s|ped|ping)?|roll(?:ed|s)?\s+over)(?=$|[,.;!?]|\s+(?:itself|again|after|when|while|and|but)\b)/.test(
      context,
    )
    || new RegExp(`\\b${counterSubject}\\s+rollover\\b`).test(context)
    || /\b(?:rollover|reset|wrap)\s+of\s+(?:the\s+)?(?:counter|week\s+(?:counter|number))\b/.test(
      context,
    );
}

function semanticBoundedValueRangeClaimMatches(detailValue) {
  const context = typeof detailValue === "string"
    ? detailValue.toLocaleLowerCase("en-US")
    : "";
  if (
    /\bleav(?:e|es|ing|ed)\s+only\s+(?:a\s+)?limited\s+(?:set|number)\s+of\s+(?:possible\s+)?values?\b/.test(
      context,
    )
  ) return true;
  const subject = "(?:counter|week\\s+(?:counter|number)|message\\s+field|bit\\s+field)";
  const bound = "(?:(?:finite|fixed|limited|maximum|minimum)\\s+(?:capacity|range|count|values?|value\\s+(?:range|space))|limited\\s+(?:set|number)\\s+of\\s+(?:possible\\s+)?values?)";
  const clauseEnd = "(?=$|[,.;!?]|\\s+(?:for|to|because|while|and|but|than)\\b)";
  return new RegExp(
    `\\b${subject}\\b\\s+(?:allows?|contains?|has|have|had|stores?|is\\s+limited\\s+to)\\s+(?:only\\s+)?(?:a\\s+)?${bound}${clauseEnd}`,
  ).test(context);
}

function semanticCounterCapacityComparisonClaimMatches(detailValue) {
  const context = typeof detailValue === "string"
    ? detailValue.toLocaleLowerCase("en-US")
    : "";
  const counter = "(?:counter|week\\s+(?:counter|number))";
  return new RegExp(
    `\\bnewer\\b.{0,20}\\bnavigation\\s+messages?\\b.{0,28}\\b(?:give|gives|gave|provide|provides|provided|allow|allows|allowed|offer|offers|offered)\\b.{0,20}\\b(?:the\\s+)?${counter}\\b.{0,16}\\bmore\\s+room\\b\\s*[.!?]?$`,
  ).test(context);
}

function semanticCounterNotTimeClaimMatches(detailValue) {
  const context = typeof detailValue === "string"
    ? detailValue.toLocaleLowerCase("en-US")
    : "";
  const subject = "(?:counter|number|value)";
  const auxiliary = "(?:(?:did|does|had|has|will|would)\\s+)?";
  const selfAction = "(?:change(?:d|s)?|reset(?:s|ting)?|roll(?:ed|s)?\\s+over|wrap(?:s|ped|ping)?)(?:\\s+(?:itself|to\\s+(?:zero|0)))?";
  const boundary = "(?=$|[,.;!?—-]|\\s+(?:and|but|not|while)\\b)";
  return new RegExp(
    `\\b${subject}\\b\\s+${auxiliary}${selfAction}${boundary}.{0,24}\\bnot\\s+time(?:\\s+itself)?(?=$|[,.;!?—])`,
  ).test(context)
    || /\bcounter\s+reset\s+(?:is|was)\s+not\s+time(?:\s+itself)?(?=$|[,.;!?—])/.test(
      context,
    )
    || new RegExp(
      `\\bnot\\s+time(?:\\s+itself)?(?=$|[,.;!?—]).{0,24}\\b(?:but|instead)\\b.{0,16}\\b(?:the\\s+)?${subject}\\b\\s+${auxiliary}${selfAction}${boundary}`,
    ).test(context);
}

function semanticCounterMappingClaimMatches(detailValue) {
  const context = typeof detailValue === "string"
    ? detailValue.toLocaleLowerCase("en-US")
    : "";
  const counter = "(?:counter|week\\s+(?:counter|number))";
  const device = "(?:devices?|equipment|receivers?|software|firmware)";
  const mapping = "(?:mapping|interpretation)\\s+mechanism";
  const activeVerb = "(?:interpret(?:s|ed|ing)?|map(?:s|ped|ping)?)";
  const passiveVerb = "(?:interpreted|mapped)";
  return new RegExp(`\\b${counter}\\s+${mapping}\\b`).test(context)
    || new RegExp(`\\b${mapping}\\b.{0,20}\\b(?:for|of)\\b.{0,12}\\b${counter}\\b`).test(context)
    || new RegExp(
      `\\b${device}\\b\\s+(?:(?:that|which)\\s+)?(?:(?:can|could|did|does|had|has|will|would)\\s+)?(?:(?:badly|correctly|incorrectly)\\s+)?${activeVerb}\\b\\s+(?:the\\s+)?${counter}\\b\\s+(?:as|to|into)\\b`,
    ).test(context)
    || new RegExp(
      `\\b${counter}\\b\\s+(?:(?:is|was|were|has\\s+been|had\\s+been|will\\s+be)\\s+)(?:(?:badly|correctly|incorrectly)\\s+)?${passiveVerb}\\b\\s+(?:as|to|into)\\b`,
    ).test(context);
}

function semanticCounterTemporalErrorClaimMatches(detailValue) {
  const context = typeof detailValue === "string"
    ? detailValue.toLocaleLowerCase("en-US")
    : "";
  if (semanticTemporalErrorKind(context) === null) return false;
  const subject = "(?:counter|devices?|equipment|receivers?|week\\s+(?:counter|number))";
  const action = "(?:display(?:ed|s|ing)?|output(?:s|ted|ting)?|show(?:ed|s|ing|n)?)";
  const error = "(?:(?:the\\s+)?(?:wrong|incorrect|impossible)\\s+(?:clocks?|dates?|time)|(?:clocks?|dates?|time)\\s+(?:was|were|is|are|look(?:ed|s)?)?\\s*(?:wrong|incorrect|impossible))";
  const ownerBridge = "(?:\\s+(?:that\\s+)?(?:handl(?:e|ed|es|ing)|interpret(?:s|ed|ing)?)\\s+(?:it|(?:the\\s+)?(?:ambiguity|counter|week\\s+number))\\s+(?:badly|incorrectly)(?:\\s+and)?)?\\s+";
  return new RegExp(
    `\\b${subject}\\b${ownerBridge}\\b${action}\\b\\s+(?:the\\s+)?${error}\\b`,
    ).test(context);
}

function semanticReceiverPatchRequiredClaimMatches(detailValue) {
  const context = typeof detailValue === "string"
    ? detailValue.toLocaleLowerCase("en-US")
    : "";
  const device = "(?:devices?|equipment|receivers?)";
  const problem = "(?:ambiguity|counter\\s+(?:ambiguity|rollovers?)|rollovers?|week\\s+number|wrong\\s+date|incorrect\\s+handling)";
  const fix = "(?:(?:software|firmware)\\s+)?(?:fix(?:es)?|patch(?:es)?|updates?|upgrades?)";
  const need = "(?:had\\s+to|must|needs?|needed|necessary|requires?|required)";
  return new RegExp(
    `\\b${device}\\b\\s+(?:that\\s+)?handl(?:e|ed|es|ing)\\s+(?:the\\s+)?${problem}\\b(?:\\s+(?:badly|incorrectly))?(?:\\s+and)?\\s+\\b${need}\\b\\s+(?:a\\s+)?${fix}\\b`,
  ).test(context)
    || new RegExp(
      `\\b${device}\\b\\s+${need}\\b\\s+(?:a\\s+)?${fix}\\b\\s+(?:for|because\\s+of|to\\s+handle)\\s+(?:the\\s+)?${problem}\\b`,
    ).test(context);
}

function semanticExplicitBitQuantityMatches(detailValue) {
  const context = typeof detailValue === "string"
    ? detailValue.toLocaleLowerCase("en-US")
    : "";
  return /\b(?:\d+|(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and)(?:[\s-]+(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and))*))\s+bits?\b/.test(
    context,
  );
}

function semanticEncodedBitClaimMatches(detailValue) {
  const context = typeof detailValue === "string"
    ? detailValue.toLocaleLowerCase("en-US")
    : "";
  if (
    !/\bbits?\b/.test(context)
    || /\bbits?\s+of\b/.test(context)
    || /\b(?:drill|router|tool)\s+bits?\b/.test(context)
    || /\bbits?\b.{0,32}\b(?:bore|cut|drill|drive|fasten|tool)\b/.test(
      context,
    )
  ) {
    return false;
  }
  const independentDigitalEvidence = /\bbit\s*field\b/.test(context)
    || /\b(?:binary|digital)\b/.test(context)
    || semanticExplicitBitQuantityMatches(context);
  if (
    /\ba\s+(?:(?:little|tiny)\s+)?bit\b/.test(context)
    && !independentDigitalEvidence
  ) return false;
  if (
    /\bbits\s+and\s+pieces\b/.test(context)
    && !independentDigitalEvidence
  ) return false;
  const numberWord = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and)";
  const bitQuantity = `(?:\\d+|${numberWord}(?:[\\s-]+${numberWord})*)\\s+bits?`;
  const bitUnit = `(?:${bitQuantity}|bits?)`;
  const digitalSubject = "(?:counters?|memory|messages?|registers?|signals?|week\\s+numbers?)";
  const digitalObject = "(?:(?:its|the|a)\\s+)?(?:(?:counter|data|field|identifier|message|value|week\\s+number)\\s+)?(?:(?:as|in|using|with)\\s+)?";
  const activeVerb = "(?:contain(?:s|ed|ing)?|stor(?:e|es|ed|ing)|encod(?:e|es|ed|ing)|represent(?:s|ed|ing)?|uses?|used|using)";
  const clauses = context.split(
    /[,.;!?]|\b(?:although|and|but|whereas|while)\b/,
  );
  return clauses.some((clause) => (
    new RegExp(
      `\\b${digitalSubject}\\b\\s+(?:(?:also|currently|directly|digitally|only|still)\\s+)?${activeVerb}\\b\\s+${digitalObject}${bitUnit}\\b\\s*$`,
    ).test(clause)
    || new RegExp(
      `\\b(?:counter|data|field|identifier|message|value|week\\s+number)\\b\\s+(?:is|was|has\\s+been|had\\s+been)\\s+(?:encoded|represented|stored)\\s+(?:in|using|with)\\s+${bitQuantity}\\b\\s*$`,
    ).test(clause)
    || new RegExp(
      `\\b(?:\\d+|${numberWord}(?:[\\s-]+${numberWord})*)[- ]bit\\s+(?:counter|field|message|number|register)\\b`,
    ).test(clause)
    || /\bbit\s*field\b\s+(?:contains?|encodes?|represents?|stores?|uses?)\b\s+(?:(?:the|a)\s+)?(?:counter|data|identifier|message|value|week\s+number)\b/.test(
      clause,
    )
  ));
}

function semanticVisualConceptGroundingMatches(input = {}) {
  const context = typeof input.detailValue === "string"
    ? input.detailValue.toLocaleLowerCase("en-US")
    : "";
  if (!groundedQuantityMatchesDetail(input)) return false;
  if (
    semanticVisualConceptBinding(input.visualConceptId)
    && !NEUTRAL_CUE_VISUAL_CONCEPT_IDS.includes(input.visualConceptId)
    && input.visualConceptId !== "counter_not_time"
    && hasOppositeClaimCue(context)
  ) return false;
  if (input.visualConceptId === "cue_evidence_document") {
    return semanticNeutralDocumentCueMatches(context);
  }
  if (input.visualConceptId === "cue_evidence_network") {
    return semanticNeutralNetworkCueMatches(context);
  }
  if (input.visualConceptId === "cue_evidence_quote") {
    return semanticNeutralQuoteCueMatches(context);
  }
  if (SAFE_NEUTRAL_CUE_VISUAL_CONCEPT_IDS.includes(input.visualConceptId)) {
    return true;
  }
  if (input.visualConceptId === "finite_counter_wrap") {
    return semanticFiniteCounterWrapClaimMatches(context);
  }
  if (input.visualConceptId === "bounded_value_range") {
    return semanticBoundedValueRangeClaimMatches(context);
  }
  if (input.visualConceptId === "counter_capacity_comparison") {
    return semanticCounterCapacityComparisonClaimMatches(context);
  }
  if (input.visualConceptId === "counter_mapping_mechanism") {
    return semanticCounterMappingClaimMatches(context);
  }
  if (input.visualConceptId === "counter_not_time") {
    return semanticCounterNotTimeClaimMatches(context);
  }
  if (input.visualConceptId === "encoded_bit_register") {
    if (!semanticEncodedBitClaimMatches(context)) return false;
    if (
      semanticExplicitBitQuantityMatches(context)
      && (
        !input.quantity
        || !/^bits?$/i.test(String(input.quantity.unit || ""))
      )
    ) return false;
    if (
      input.quantity
      && !/^bits?$/i.test(String(input.quantity.unit || ""))
    ) return false;
  }
  if (input.visualConceptId === "counter_date_misinterpretation") {
    return semanticCounterTemporalErrorClaimMatches(context);
  }
  if (input.visualConceptId === "receiver_patch_required") {
    return semanticReceiverPatchRequiredClaimMatches(context);
  }
  return true;
}

function semanticVisualConceptRendererVariant(input = {}) {
  const conceptBinding = semanticVisualConceptBinding(input.visualConceptId);
  if (
    conceptBinding
    && semanticVisualConceptBindingMatches(input)
  ) return conceptBinding.rendererVariant;
  if (NEUTRAL_CUE_VISUAL_CONCEPT_IDS.includes(input.visualConceptId)) {
    return input.visualConceptId;
  }
  if (input.grammarId === "cause_effect_chain") {
    return input.stateToken === "REJECTED"
      ? "generic_cause_effect_rejected"
      : "generic_cause_effect";
  }
  if (input.grammarId === "side_by_side_comparison") {
    return input.stateTransition === "reject_hypothesis"
      ? "generic_comparison_rejected"
      : "generic_comparison";
  }
  return typeof input.grammarId === "string" && input.grammarId
    ? `generic_${input.grammarId}`
    : null;
}

module.exports = {
  GROUNDED_NEUTRAL_CUE_VISUAL_CONCEPT_IDS,
  NEUTRAL_CUE_VISUAL_CONCEPT_IDS,
  NEUTRAL_SEMANTIC_VISUAL_CONCEPT_BINDINGS,
  SAFE_NEUTRAL_CUE_VISUAL_CONCEPT_IDS,
  SPECIALIZED_SEMANTIC_VISUAL_CONCEPT_BINDINGS,
  UPCOMING_SEMANTIC_VISUAL_CONCEPT_IDS,
  groundedNeutralCueVisualConceptIds,
  semanticVisualConceptBinding,
  semanticVisualConceptBindingMatches,
  semanticVisualConceptGroundingMatches,
  semanticVisualConceptRendererVariant,
  semanticVisualConceptTransitionMatches,
  semanticBoundedValueRangeClaimMatches,
  semanticEncodedBitClaimMatches,
  semanticExplicitBitQuantityMatches,
  semanticCounterCapacityComparisonClaimMatches,
  semanticCounterMappingClaimMatches,
  semanticCounterNotTimeClaimMatches,
  semanticCounterTemporalErrorClaimMatches,
  semanticFiniteCounterWrapClaimMatches,
  semanticNeutralDocumentCueMatches,
  semanticNeutralNetworkCueMatches,
  semanticNeutralQuoteCueMatches,
  semanticReceiverPatchRequiredClaimMatches,
  semanticTemporalErrorKind,
};
