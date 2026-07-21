"use strict";

const { createHash } = require("node:crypto");

const { AppError } = require("../../../errors.cjs");
const { stableStringify } = require("./canonical-json.cjs");
const {
  SEMANTIC_SENTENCE_RENDERER_ASSET_IDS,
  SEMANTIC_SENTENCE_RENDERER_CAPABILITY_PAIRS,
  SEMANTIC_SENTENCE_RENDERER_GRAMMAR_IDS,
  SEMANTIC_SENTENCE_ROLES,
} = require("./semantic-render-profile.cjs");
const {
  NARRATIVE_SHAPE_BY_VOCABULARY,
  validateStoryIRAgainstDraft,
} = require("./story-ir.cjs");
const {
  compatibleAssetsForProposition,
  compatibleGrammarsForProposition,
  normalizeVisualCapabilityProposition,
} = require("./visual-capability-registry.cjs");
const {
  SAFE_NEUTRAL_CUE_VISUAL_CONCEPT_IDS,
  groundedNeutralCueVisualConceptIds,
  semanticBoundedValueRangeClaimMatches,
  semanticCounterCapacityComparisonClaimMatches,
  semanticCounterMappingClaimMatches,
  semanticCounterNotTimeClaimMatches,
  semanticCounterTemporalErrorClaimMatches,
  semanticEncodedBitClaimMatches,
  semanticFiniteCounterWrapClaimMatches,
  semanticReceiverPatchRequiredClaimMatches,
} = require("./semantic-visual-concept-registry.cjs");

const VISUAL_INTENT_GRAPH_SCHEMA_VERSION = 1;
const VISUAL_INTENT_GRAPH_PROFILE_ID = "dark_curiosity_visual_intent_graph_v1";
const VISUAL_INTENT_PRIMITIVE_PAYLOAD_PROFILE_ID =
  "dark_curiosity_grounded_primitive_payload_v2";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z][a-z0-9_-]{2,119}$/;
const CLAIM_ID_PATTERN = /^claim_[A-Za-z0-9-]{2,72}$/;
const CERTAINTIES = Object.freeze(["verified", "qualified", "disputed"]);
const EVENT_KINDS = Object.freeze([
  "archival_evidence",
  "bounded_interpretation",
  "causal_action",
  "entity_state",
  "epistemic_state",
  "measured_extent",
  "observed_state_change",
  "rejected_interpretation",
  "state_transition",
  "temporal_relation",
]);
const EPISTEMIC_STATUSES = Object.freeze([
  "supported_fact",
  "qualified_analysis",
  "unknown",
]);

const INTENT_BLUEPRINTS = Object.freeze({
  radio_signal: Object.freeze({
    hook: blueprint("story_record", "appearance", "record", "become_visible", "archival_evidence", "appears"),
    context: blueprint("signal_timeline", "comparison", "timeline", "compare_states", "measured_extent", "measures"),
    evidence: blueprint("signal_mapping", "cause_effect", "mapping", "map_input_to_output", "causal_action", "indicates"),
    turn: blueprint("story_record", "last_known_record", "record", "mark_last_known", "temporal_relation", "records"),
    payoff: blueprint("signal_hypothesis", "bounded_uncertainty", "hypothesis", "remain_unresolved", "bounded_interpretation", "remains_unknown"),
  }),
  temporal_anomaly: Object.freeze({
    hook: blueprint("timestamp_record", "appearance", "record", "become_visible", "archival_evidence", "appears"),
    context: blueprint("time_counter", "mechanism_reveal", "finite_counter", "reveal_structure", "entity_state", "records"),
    evidence: blueprint("time_mapping", "cause_effect", "mapping", "map_input_to_output", "causal_action", "causes"),
    turn: blueprint("time_date", "state_change", "date", "change_value", "state_transition", "changes_to"),
    payoff: blueprint("time_hypothesis", "bounded_uncertainty", "hypothesis", "remain_unresolved", "bounded_interpretation", "remains_unknown"),
  }),
  maritime_route: Object.freeze({
    hook: blueprint("story_vessel", "appearance", "vessel", "become_visible", "archival_evidence", "appears"),
    context: blueprint("voyage_record", "last_known_record", "record", "mark_last_known", "temporal_relation", "records"),
    evidence: blueprint("story_vessel", "movement", "vessel", "move_along_path", "observed_state_change", "moves"),
    turn: blueprint("story_vessel", "movement", "vessel", "move_along_path", "observed_state_change", "drifts"),
    payoff: blueprint("story_hypothesis", "bounded_uncertainty", "hypothesis", "remain_unresolved", "bounded_interpretation", "remains_unknown"),
  }),
  general_mystery: Object.freeze({
    hook: blueprint("story_record", "appearance", "record", "become_visible", "archival_evidence", "appears"),
    context: blueprint("story_timeline", "last_known_record", "timeline", "mark_last_known", "temporal_relation", "records"),
    evidence: blueprint("story_timeline", "comparison", "timeline", "compare_states", "archival_evidence", "compares_with"),
    turn: blueprint("story_hypothesis", "negation", "hypothesis", "reject_hypothesis", "rejected_interpretation", "is_not", "negated"),
    payoff: blueprint("story_hypothesis", "bounded_uncertainty", "hypothesis", "remain_unresolved", "epistemic_state", "remains_unknown"),
  }),
});

function contains(textValue, pattern) {
  return pattern.test(String(textValue || "").toLocaleLowerCase("en-US"));
}

function strictCausalClaimMatches(value) {
  return contains(
    value,
    /\b(?:caus(?:e|ed|es|ing)|because(?:\s+of)?|led\s+to|results?(?:ed|ing)?\s+in)\b/,
  );
}

function strictModalUncertaintyMatches(value) {
  const raw = String(value || "");
  return /\b(?:could|might|remains?\s+possible)\b/i.test(raw)
    || /\bmay\b/.test(raw);
}

function strictReportedAssumptionMatches(value) {
  const context = String(value || "").toLocaleLowerCase("en-US");
  return /\b[a-z][a-z'’-]{1,30}\s+(?:had\s+)?(?:assumed|believed|thought)\s+(?:a|an|he|it|she|that|the|there|they|this|we)\b/.test(
    context,
  )
    || /\b(?:it|signal|ship|transmission|value|vessel)\s+(?:had\s+been|is|was)\s+(?:assumed|believed|thought)\s+to\b/.test(
      context,
    );
}

function strictSignalNonrecurrenceClaimMatches(value) {
  const context = String(value || "").toLocaleLowerCase("en-US");
  const signal = "(?:detections?|signals?|transmissions?)";
  return new RegExp(
    `\\b${signal}\\b\\s+(?:did\\s+not|never|was\\s+not|were\\s+not)\\s+(?:appear\\s+again|recur|recurred|repeat|repeated|return|returned)\\b`,
  ).test(context)
    || new RegExp(
      `\\bnever\\s+(?:detected|found|observed|received|verified)\\b.{0,40}\\b(?:the\\s+)?(?:same\\s+)?${signal}\\b(?:.{0,16}\\bagain\\b)?`,
    ).test(context)
    || new RegExp(
      `\\bno\\s+(?:repeat(?:ed|ing)?|recurring)\\s+${signal}\\b`,
    ).test(context)
    || new RegExp(
      `\\bno\\s+${signal}\\b.{0,20}\\b(?:again|recurred|returned)\\b`,
    ).test(context);
}

function strictRecurrenceClaimMatches(value) {
  return contains(
    value,
    /\b(?:reappeared|recurred|came\s+back)\b|\b(?:appeared|returned|happened|occurred|was\s+(?:seen|sighted|spotted|observed|detected)|were\s+(?:seen|sighted|spotted|observed|detected))\s+again\b|\bagain\b.{0,32}\b(?:appeared|returned|happened|occurred|came\s+back)\b|\brepeated\b.{0,56}\b(?:again|each|every|twice|thrice|multiple\s+times|\d+\s+times?)\b|\b(?:reset(?:s|ting)?|wrap(?:s|ped|ping)?|roll(?:ed|s)?\s+over)\b.{0,40}\b(?:again|each|every|twice|thrice|multiple\s+times|\d+\s+times?)\b|\brepeated\s+(?:appearances?|detections?|events?|occurrences?|signals?|sightings?|transmissions?|visits?)\b/,
  );
}

function neutralCueBlueprint(
  beat,
  segmentIndex,
  cueValue,
  recentVisualConceptIds = [],
) {
  const groundedCandidates = groundedNeutralCueVisualConceptIds(cueValue);
  const candidates = [
    ...groundedCandidates,
    ...SAFE_NEUTRAL_CUE_VISUAL_CONCEPT_IDS,
  ].filter((candidate, index, values) => values.indexOf(candidate) === index);
  const recentWindow = recentVisualConceptIds.slice(-4);
  const previous = recentVisualConceptIds.at(-1) || null;
  const prospectiveCount = recentVisualConceptIds.length + 1;
  const dominantAllowance = Math.max(
    2,
    Math.floor(prospectiveCount * 0.25),
  );
  const occurrenceCount = (candidate, values) => values.reduce(
    (count, value) => count + (value === candidate ? 1 : 0),
    0,
  );
  const acceptable = (candidate) => (
    candidate !== previous
    && occurrenceCount(candidate, recentWindow) < 2
    && occurrenceCount(candidate, recentVisualConceptIds) + 1
      <= dominantAllowance
  );
  const groundedChoice = groundedCandidates.find(acceptable);
  const safeChoices = SAFE_NEUTRAL_CUE_VISUAL_CONCEPT_IDS
    .map((candidate, order) => ({
      candidate,
      count: occurrenceCount(candidate, recentVisualConceptIds),
      order,
    }))
    .sort((left, right) => left.count - right.count || left.order - right.order)
    .map(({ candidate }) => candidate);
  const visualConceptId = groundedChoice
    || safeChoices.find(acceptable)
    || candidates[0];
  return blueprint(
    `cue_${beat.role}_${segmentIndex}`,
    "appearance",
    "record",
    "become_visible",
    "archival_evidence",
    "appears",
    "affirmed",
    visualConceptId,
  );
}

function isGpsWeekCounterStory(storyIR) {
  const groundedText = storyIR.beats.flatMap((beat) => [
    beat.source.heading,
    beat.source.primaryLabel,
    beat.source.secondaryLabel,
    beat.source.onScreenText,
    ...beat.segments.map((segment) => segment.text),
  ]).join(" ").toLocaleLowerCase("en-US");
  return /\bgps\b/.test(groundedText)
    && /\b(?:civil signal|counter|rollover|week number|week)\b/.test(
      groundedText,
    );
}

function storyBlueprint(storyVocabulary, semanticKind, gpsWeekCounter = false) {
  if (semanticKind === "signal_frequency") {
    return blueprint(
      "signal_timeline",
      "comparison",
      "timeline",
      "compare_states",
      "measured_extent",
      "compares_with",
      "affirmed",
      "signal_frequency_band",
    );
  }
  if (semanticKind === "signal_nonrecurrence") {
    return blueprint(
      "story_record",
      "recurrence",
      "record",
      "repeat_cycle",
      "archival_evidence",
      "reappears",
      "negated",
      "signal_nonrecurrence",
    );
  }
  if (semanticKind === "missing_confirmation") {
    return blueprint(
      "story_hypothesis",
      "bounded_uncertainty",
      "hypothesis",
      "remain_unresolved",
      "epistemic_state",
      "remains_unknown",
      "affirmed",
      "missing_confirmation",
    );
  }
  if (semanticKind === "reported_assumption") {
    return blueprint(
      "story_hypothesis",
      "bounded_uncertainty",
      "hypothesis",
      "remain_unresolved",
      "bounded_interpretation",
      "remains_unknown",
      "affirmed",
      "reported_assumption",
    );
  }
  if (semanticKind === "witness_sighting") {
    return blueprint(
      "story_observer",
      "appearance",
      "observer",
      "become_visible",
      "archival_evidence",
      "appears",
      "affirmed",
      "witness_sighting",
    );
  }
  if (semanticKind === "documented_record") {
    return blueprint(
      "story_record",
      "appearance",
      "record",
      "become_visible",
      "archival_evidence",
      "appears",
      "affirmed",
      "documented_record",
    );
  }
  if (semanticKind === "negation") {
    return blueprint(
      "story_hypothesis",
      "negation",
      "hypothesis",
      "reject_hypothesis",
      "rejected_interpretation",
      "is_not",
      "negated",
      gpsWeekCounter
        ? "counter_not_time"
        : "hypothesis_rejection",
    );
  }
  if (semanticKind === "uncertainty") {
    return blueprint(
      "story_hypothesis",
      "bounded_uncertainty",
      "hypothesis",
      "remain_unresolved",
      "bounded_interpretation",
      "remains_unknown",
      "affirmed",
      "bounded_uncertainty",
    );
  }
  if (semanticKind === "disappearance") {
    return storyVocabulary === "maritime_route"
      ? blueprint("story_vessel", "disappearance", "vessel", "become_absent", "observed_state_change", "disappears", "affirmed", "vessel_disappearance")
      : blueprint("story_record", "last_known_record", "record", "mark_last_known", "temporal_relation", "records", "affirmed", "record_disappearance");
  }
  if (semanticKind === "recurrence") {
    if (storyVocabulary === "temporal_anomaly" && gpsWeekCounter) {
      return blueprint("story_counter", "recurrence", "finite_counter", "repeat_cycle", "state_transition", "follows", "affirmed", "finite_counter_wrap");
    }
    if (storyVocabulary === "maritime_route") {
      return blueprint("story_vessel", "recurrence", "vessel", "repeat_cycle", "observed_state_change", "reappears");
    }
    return blueprint("story_record", "recurrence", "record", "repeat_cycle", "archival_evidence", "reappears");
  }
  if (semanticKind === "misinterpretation") {
    if (!gpsWeekCounter) {
      return blueprint(
        "story_mapping",
        "misinterpretation",
        "mapping",
        "map_to_incorrect_output",
        "causal_action",
        "causes",
        "affirmed",
        "source_misinterpretation",
      );
    }
    return blueprint(
      "story_device",
      "misinterpretation",
      "device",
      "map_to_incorrect_output",
      "causal_action",
      "causes",
      "affirmed",
      "counter_date_misinterpretation",
    );
  }
  if (semanticKind === "date_misinterpretation") {
    return blueprint(
      "time_date",
      "misinterpretation",
      "date",
      "map_to_incorrect_output",
      "causal_action",
      "causes",
      "affirmed",
      gpsWeekCounter
        ? "counter_date_misinterpretation"
        : "date_source_misinterpretation",
    );
  }
  if (semanticKind === "remediation") {
    if (!gpsWeekCounter) {
      return blueprint(
        "story_mapping",
        "remediation",
        "mapping",
        "require_update",
        "causal_action",
        "causes",
        "affirmed",
        "source_remediation",
      );
    }
    return blueprint(
      "story_device",
      "remediation",
      "device",
      "require_update",
      "causal_action",
      "causes",
      "affirmed",
      "receiver_patch_required",
    );
  }
  if (semanticKind === "encoding") {
    return blueprint(
      "story_mapping",
      "mechanism_reveal",
      "mapping",
      "reveal_structure",
      "entity_state",
      "records",
      "affirmed",
      "encoded_bit_register",
    );
  }
  if (semanticKind === "capacity") {
    return blueprint(
      "capacity_counter",
      "capacity_limit",
      "finite_counter",
      "reach_capacity",
      "measured_extent",
      "limits",
      "affirmed",
      "bounded_value_range",
    );
  }
  if (semanticKind === "capacity_comparison") {
    if (!gpsWeekCounter) {
      return blueprint(
        "story_timeline",
        "comparison",
        "timeline",
        "compare_states",
        "measured_extent",
        "compares_with",
        "affirmed",
        "capacity_comparison",
      );
    }
    return blueprint(
      "capacity_counter",
      "comparison",
      "finite_counter",
      "compare_states",
      "measured_extent",
      "compares_with",
      "affirmed",
      "counter_capacity_comparison",
    );
  }
  if (semanticKind === "duration") {
    return blueprint(
      "story_timeline",
      "last_known_record",
      "timeline",
      "accumulate_records",
      "temporal_relation",
      "records",
      "affirmed",
      "duration_timeline",
    );
  }
  if (semanticKind === "future_marker") {
    return blueprint(
      "story_timeline",
      "last_known_record",
      "timeline",
      "mark_last_known",
      "temporal_relation",
      "records",
      "affirmed",
      gpsWeekCounter
        ? "future_rollover_timeline"
        : "future_event_timeline",
    );
  }
  if (semanticKind === "movement") {
    return blueprint("story_vessel", "movement", "vessel", "move_along_path", "observed_state_change", "moves");
  }
  if (semanticKind === "number") {
    if (storyVocabulary === "temporal_anomaly") {
      return blueprint("story_counter", "capacity_limit", "finite_counter", "reach_capacity", "measured_extent", "limits");
    }
    return blueprint("story_timeline", "comparison", "timeline", "compare_states", "measured_extent", "measures");
  }
  if (semanticKind === "cause") {
    return blueprint(
      "story_mapping",
      "cause_effect",
      "mapping",
      "map_input_to_output",
      "causal_action",
      "causes",
      "affirmed",
      gpsWeekCounter
        ? "counter_mapping_mechanism"
        : "mapping_cause_effect",
    );
  }
  if (semanticKind === "chronology") {
    return blueprint("story_timeline", "last_known_record", "timeline", "mark_last_known", "temporal_relation", "records");
  }
  return null;
}

function selectIntentBlueprint(
  storyIR,
  beat,
  segment,
  segmentIndex,
  recentVisualConceptIds = [],
) {
  const value = segment.text;
  const gpsWeekCounter = isGpsWeekCounterStory(storyIR);
  const previousSegment = Number.isSafeInteger(segmentIndex) && segmentIndex > 0
    ? beat.segments[segmentIndex - 1]
    : null;
  const nextSegment = Number.isSafeInteger(segmentIndex)
    && segmentIndex + 1 < beat.segments.length
    ? beat.segments[segmentIndex + 1]
    : null;
  const gpsPronounCounterRecurrenceContext = Boolean(
    gpsWeekCounter
    && previousSegment
    && previousSegment.endWordIndex === segment.startWordIndex
    && /\b(?:that|the|gps|week)\s+(?:week\s+)?counter\b/i.test(
      previousSegment.text,
    )
    && /^\s*(?:when\s+)?it\s+(?:rolled\s+over|reset|wrapped)[,.;!?]?\s*$/i.test(
      value,
    ),
  );
  const gpsTemporalErrorContext = gpsWeekCounter
    && semanticCounterTemporalErrorClaimMatches(value);
  const gpsRecurrenceContext = gpsWeekCounter
    && semanticFiniteCounterWrapClaimMatches(value);
  const gpsRemediationContext = gpsWeekCounter
    && semanticReceiverPatchRequiredClaimMatches(value);
  const gpsCounterNotTimeContext = gpsWeekCounter
    && semanticCounterNotTimeClaimMatches(value);
  const gpsCapacityComparisonContext = gpsWeekCounter
    && semanticCounterCapacityComparisonClaimMatches(value);
  const gpsFutureRolloverContext = gpsWeekCounter && (
    semanticFiniteCounterWrapClaimMatches(value)
    || contains(
      value,
      /\blegacy\s+receivers?\b.{0,24}\bface(?:s|d)?\b.{0,16}\b(?:another\s+)?(?:counter\s+)?rollover\b/,
    )
  );
  const gpsCounterCauseContext = gpsWeekCounter
    && semanticCounterMappingClaimMatches(value);
  const capacityComparisonDisqualifiedByNextSegment = Boolean(
    nextSegment
    && segment.endWordIndex === nextSegment.startWordIndex
    && contains(value, /\bmore\s+room\b/)
    && /^\s*(?:but\s+)?only\s+(?:in|on)\s+(?:the\s+)?(?:printed\s+)?(?:article|document|layout|page)\b/i.test(
      nextSegment.text,
    ),
  );
  const blueprintFor = (semanticKind, useGpsCounterConcept = false) => storyBlueprint(
    storyIR.storyVocabulary,
    semanticKind,
    useGpsCounterConcept,
  );
  const broadSignalNonrecurrenceVocabulary = (
    storyIR.storyVocabulary === "radio_signal"
    && contains(value, /\bno\s+(?:repeat\s+button|repeated\s+pattern)\b/)
  );
  if (
    storyIR.storyVocabulary === "radio_signal"
    && strictSignalNonrecurrenceClaimMatches(value)
  ) {
    return storyBlueprint(
      storyIR.storyVocabulary,
      "signal_nonrecurrence",
      false,
    );
  }
  if (broadSignalNonrecurrenceVocabulary) {
    return neutralCueBlueprint(
      beat,
      segmentIndex,
      value,
      recentVisualConceptIds,
    );
  }
  if (contains(value, /\b(?:not|never)\b/)) {
    return blueprintFor("negation", gpsCounterNotTimeContext);
  }
  if (
    storyIR.storyVocabulary === "radio_signal"
    && contains(
      value,
      /\bno\s+(?:(?:confirmed|verified)\s+(?:evidence|signal|transmission|verification)|(?:repeatable|reproducible)\s+(?:evidence|proof|confirmation))\b/,
    )
  ) {
    return storyBlueprint(
      storyIR.storyVocabulary,
      "missing_confirmation",
      false,
    );
  }
  if (contains(value, /\bno\b/)) {
    return blueprintFor("negation", gpsCounterNotTimeContext);
  }
  if (contains(value, /\b(unexplained|unresolved|unknown|uncertain|mystery|no answer)\b/)) {
    return blueprintFor("uncertainty");
  }
  if (strictModalUncertaintyMatches(value)) {
    return blueprintFor("uncertainty");
  }
  if (strictReportedAssumptionMatches(value)) {
    return storyBlueprint(
      storyIR.storyVocabulary,
      "reported_assumption",
      false,
    );
  }
  if (contains(
    value,
    /\b(?:less convincing|less likely|weaken(?:ed|s)?|ruled out)\b/,
  )) {
    return storyBlueprint(storyIR.storyVocabulary, "negation", false);
  }
  if (contains(
    value,
    /\b(?:(?:needs?|needed|requires?|required)\b.{0,48}\b(?:(?:software|firmware)\s+)?(?:fix(?:es)?|patch(?:es)?|updates?|upgrades?)|(?:software|firmware)\s+(?:fix(?:es)?|patch(?:es)?|updates?|upgrades?)\b.{0,32}\b(?:needed|required)|must\s+(?:be\s+)?(?:fixed|patched|updated|upgraded))\b/,
  )) {
    if (gpsWeekCounter && !gpsRemediationContext) {
      return neutralCueBlueprint(
        beat,
        segmentIndex,
        value,
        recentVisualConceptIds,
      );
    }
    return storyBlueprint(
      storyIR.storyVocabulary,
      "remediation",
      gpsRemediationContext,
    );
  }
  if (
    contains(value, /\b(?:clock|clocks|date|dates|time)\b/)
    && contains(value, /\b(?:haunted|impossible|incorrect|wrong)\b/)
  ) {
    if (gpsWeekCounter && !gpsTemporalErrorContext) {
      return neutralCueBlueprint(
        beat,
        segmentIndex,
        value,
        recentVisualConceptIds,
      );
    }
    return storyBlueprint(
      storyIR.storyVocabulary,
      contains(value, /\b(?:devices?|equipment|receivers?)\b/)
        ? "misinterpretation"
        : "date_misinterpretation",
      gpsTemporalErrorContext,
    );
  }
  if (contains(
    value,
    /\b(?:ambiguity|incorrect(?:ly)?|misread|misreads|misreading|misinterpret(?:ed|s|ation)?|wrong)\b/,
  )) {
    return storyBlueprint(
      storyIR.storyVocabulary,
      "misinterpretation",
      false,
    );
  }
  if (gpsCounterCauseContext) {
    return blueprintFor("cause", true);
  }
  if (strictCausalClaimMatches(value)) {
    return blueprintFor("cause", gpsCounterCauseContext);
  }
  if (capacityComparisonDisqualifiedByNextSegment) {
    return neutralCueBlueprint(
      beat,
      segmentIndex,
      value,
      recentVisualConceptIds,
    );
  }
  if (contains(
    value,
    /\b(?:greater|larger|more|wider)\s+(?:capacity|room|range|values?|bit\s+field)\b|(?:\bnewer\b.{0,48}\blegacy\b|\blegacy\b.{0,48}\bnewer\b).{0,48}\b(?:capacity|counter|messages?|range|room|values?)\b/,
  )) {
    return blueprintFor(
      "capacity_comparison",
      gpsCapacityComparisonContext,
    );
  }
  if (
    contains(value, /\b(?:19|20)\d{2}\b/)
    && (
      contains(value, /\b(?:future|next|predicted|scheduled|upcoming)\b/)
      || (
        contains(value, /\b(?:another|face(?:s|d)?|will)\b/)
        && contains(
          value,
          /\b(?:resets?|resetting|rollovers?|roll(?:ed|s)? over|wrap(?:s|ped|ping)?)\b/,
        )
      )
    )
  ) {
    return blueprintFor("future_marker", gpsFutureRolloverContext);
  }
  const broadRecurrenceVocabulary = contains(
    value,
    /\b(?:repeat(?:ed|able)?|again|cycle|recurr(?:ed|ing)?|rollovers?|roll(?:ed|s)?\s+over|resets?|resetting|wrap(?:s|ped|ping)?)\b/,
  );
  if (
    gpsRecurrenceContext
    || gpsPronounCounterRecurrenceContext
    || strictRecurrenceClaimMatches(value)
  ) {
    if (gpsPronounCounterRecurrenceContext && !gpsRecurrenceContext) {
      return blueprint(
        "story_counter",
        "recurrence",
        "finite_counter",
        "repeat_cycle",
        "state_transition",
        "follows",
        "affirmed",
        "counter_recurrence",
      );
    }
    if (gpsWeekCounter && !gpsRecurrenceContext) {
      return neutralCueBlueprint(
        beat,
        segmentIndex,
        value,
        recentVisualConceptIds,
      );
    }
    return storyBlueprint(
      storyIR.storyVocabulary,
      "recurrence",
      gpsRecurrenceContext,
    );
  }
  if (broadRecurrenceVocabulary) {
    return neutralCueBlueprint(
      beat,
      segmentIndex,
      value,
      recentVisualConceptIds,
    );
  }
  if (contains(
    value,
    /\b(?:cover(?:s|ed)?|last(?:s|ed)?|span(?:s|ned)?|stretch(?:es|ed)?)\b.{0,56}\b(?:days?|hours?|minutes?|months?|seconds?|weeks?|years?)\b|\b(?:days?|hours?|minutes?|months?|seconds?|weeks?|years?)\b.{0,32}\b(?:apart|later|long)\b|\b(?:\d+|(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and)(?:[\s-]+(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and))*))\s+(?:days?|hours?|minutes?|months?|seconds?|weeks?|years?)\b/,
  )) {
    return blueprintFor("duration");
  }
  if (semanticEncodedBitClaimMatches(value)) {
    return blueprintFor("encoding");
  }
  if (semanticBoundedValueRangeClaimMatches(value)) {
    return blueprintFor("capacity");
  }
  if (contains(value, /\b(never|vanish(?:ed)?|disappear(?:ed)?|absent|gone|missing|no longer|left no)\b/)) {
    return blueprintFor("disappearance");
  }
  if (
    storyIR.storyVocabulary === "maritime_route"
    && contains(value, /\b(drift(?:ed|ing)?|move(?:d|ment)?|route|cross(?:ed|ing)?|ice|voyage)\b/)
  ) return blueprintFor("movement");
  if (
    storyIR.storyVocabulary === "radio_signal"
    && contains(value, /\b(?:frequency|frequencies|signal band|radio band)\b/)
  ) return blueprintFor("signal_frequency");
  if (contains(
    value,
    /\b(?:decades?|years?|months?|weeks?|days?)\s+(?:after|before|later)\b|\b(?:after|before)\b.{0,36}\b(?:decades?|years?|months?|weeks?|days?)\b/,
  )) {
    return blueprintFor("chronology");
  }
  if (
    contains(value, /\b(?:documented|recorded|verified)\b/)
    && !contains(value, /\b(?:never|no|not|unverified)\b/)
    && !contains(
      value,
      /\b(?:caus(?:e|ed|es)|because|through|making|mechanism|mapped?|crossed)\b/,
    )
  ) {
    return storyBlueprint(
      storyIR.storyVocabulary,
      "documented_record",
      false,
    );
  }
  if (
    storyIR.storyVocabulary === "maritime_route"
    && contains(value, /\b(?:observed|saw|sighted|spotted)\b/)
  ) {
    return storyBlueprint(
      storyIR.storyVocabulary,
      "witness_sighting",
      false,
    );
  }
  if (contains(value, /\b(?:18|19|20)\d{2}\b/)) {
    return blueprintFor("chronology");
  }
  if (contains(value, /\b\d+\b/)) {
    return blueprintFor("number");
  }
  return neutralCueBlueprint(
    beat,
    segmentIndex,
    value,
    recentVisualConceptIds,
  );
}

function blueprint(
  entityKey,
  predicate,
  subjectKind,
  stateTransition,
  eventKind,
  semanticPredicate,
  polarity = "affirmed",
  visualConceptId = null,
) {
  return Object.freeze({
    entityKey,
    visualIntent: Object.freeze({ predicate, subjectKind, stateTransition }),
    eventKind,
    semanticPredicate,
    polarity,
    visualConceptId: visualConceptId
      || `semantic_${subjectKind}_${predicate}`,
  });
}

function fail(field, reason = "invalid") {
  throw new AppError(
    "ANIMATION_VISUAL_INTENT_GRAPH_INVALID",
    "The visual intent graph is invalid or is not grounded in the story representation.",
    409,
    { field, reason },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, field, optional = []) {
  if (!isPlainObject(value)) fail(field, "object_required");
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) {
    fail(`${field}.${key}`, "unsupported_field");
  }
  for (const key of required) if (!Object.hasOwn(value, key)) {
    fail(`${field}.${key}`, "field_required");
  }
}

function text(value, field, options = {}) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.length > (options.max || 320)
    || (options.pattern && !options.pattern.test(value))
  ) fail(field, "non_empty_safe_text_required");
  return value;
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function integer(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(field, "integer_out_of_range");
  }
  return value;
}

function stringList(value, field, options = {}) {
  if (
    !Array.isArray(value)
    || value.length < (options.minimum || 0)
    || value.length > (options.maximum || 24)
  ) fail(field, "array_size_invalid");
  const normalized = value.map((entry, index) => text(entry, `${field}[${index}]`, {
    max: options.max || 80,
    pattern: options.pattern,
  }));
  if (new Set(normalized).size !== normalized.length) fail(field, "duplicates_not_allowed");
  return normalized;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function contentHash(value) {
  const copy = structuredClone(value);
  delete copy.contentHash;
  return createHash("sha256").update(stableStringify(copy)).digest("hex");
}

function normalizeBindings(input) {
  exactKeys(input, [
    "storyIRHash",
    "draftHash",
    "sourceStoryboardHash",
    "timingContextHash",
    "alignmentHash",
  ], "visualIntentGraph.bindings");
  const hash = (value, field) => text(value, field, { max: 64, pattern: HASH_PATTERN });
  return {
    storyIRHash: hash(input.storyIRHash, "visualIntentGraph.bindings.storyIRHash"),
    draftHash: hash(input.draftHash, "visualIntentGraph.bindings.draftHash"),
    sourceStoryboardHash: hash(
      input.sourceStoryboardHash,
      "visualIntentGraph.bindings.sourceStoryboardHash",
    ),
    timingContextHash: hash(
      input.timingContextHash,
      "visualIntentGraph.bindings.timingContextHash",
    ),
    alignmentHash: hash(
      input.alignmentHash,
      "visualIntentGraph.bindings.alignmentHash",
    ),
  };
}

function normalizeEntity(input, index) {
  const field = `visualIntentGraph.entities[${index}]`;
  exactKeys(input, [
    "id",
    "label",
    "labelBeatId",
    "subjectKind",
    "persistent",
    "claimIds",
  ], field);
  if (typeof input.persistent !== "boolean") fail(`${field}.persistent`, "boolean_required");
  return {
    id: text(input.id, `${field}.id`, { max: 120, pattern: ID_PATTERN }),
    label: text(input.label, `${field}.label`, { max: 120 }),
    labelBeatId: text(input.labelBeatId, `${field}.labelBeatId`, {
      max: 80,
      pattern: ID_PATTERN,
    }),
    subjectKind: text(input.subjectKind, `${field}.subjectKind`, {
      max: 80,
      pattern: ID_PATTERN,
    }),
    persistent: input.persistent,
    claimIds: stringList(input.claimIds, `${field}.claimIds`, {
      minimum: 1,
      maximum: 6,
      pattern: CLAIM_ID_PATTERN,
    }),
  };
}

function normalizeWordSpan(input, field) {
  exactKeys(input, [
    "startWordIndex",
    "endWordIndex",
    "startFrame",
    "endFrame",
    "text",
  ], field);
  const startWordIndex = integer(input.startWordIndex, `${field}.startWordIndex`, 0, 399);
  const startFrame = integer(input.startFrame, `${field}.startFrame`, 0, 5399);
  return {
    startWordIndex,
    endWordIndex: integer(
      input.endWordIndex,
      `${field}.endWordIndex`,
      startWordIndex + 1,
      400,
    ),
    startFrame,
    endFrame: integer(input.endFrame, `${field}.endFrame`, startFrame + 1, 5400),
    text: text(input.text, `${field}.text`, { max: 400 }),
  };
}

function normalizePrimitivePayload(input, field) {
  exactKeys(input, [
    "profileId",
    "visualConceptId",
    "headline",
    "detail",
    "sourceSceneId",
    "sourceOperationIndexes",
    "geometry",
  ], field);
  if (input.profileId !== VISUAL_INTENT_PRIMITIVE_PAYLOAD_PROFILE_ID) {
    fail(`${field}.profileId`, "unsupported_profile");
  }
  if (
    !Array.isArray(input.sourceOperationIndexes)
    || input.sourceOperationIndexes.length < 1
    || input.sourceOperationIndexes.length > 12
  ) fail(`${field}.sourceOperationIndexes`, "array_size_invalid");
  const sourceOperationIndexes = input.sourceOperationIndexes.map((value, index) => (
    integer(value, `${field}.sourceOperationIndexes[${index}]`, 0, 39)
  ));
  if (
    new Set(sourceOperationIndexes).size !== sourceOperationIndexes.length
    || sourceOperationIndexes.some((value, index) => (
      index > 0 && value <= sourceOperationIndexes[index - 1]
    ))
  ) fail(`${field}.sourceOperationIndexes`, "ordered_unique_indexes_required");
  exactKeys(
    input.geometry,
    Object.hasOwn(input.geometry, "points") ? ["points"] : [],
    `${field}.geometry`,
  );
  const geometry = {};
  if (input.geometry.points !== undefined) {
    if (
      !Array.isArray(input.geometry.points)
      || input.geometry.points.length < 2
      || input.geometry.points.length > 12
    ) fail(`${field}.geometry.points`, "route_points_invalid");
    geometry.points = input.geometry.points.map((point, pointIndex) => {
      if (
        !Array.isArray(point)
        || point.length !== 2
        || point.some((coordinate) => (
          !Number.isFinite(coordinate)
          || coordinate < 0
          || coordinate > 1
        ))
      ) fail(`${field}.geometry.points[${pointIndex}]`, "point_out_of_range");
      return [...point];
    });
  }
  return {
    profileId: input.profileId,
    visualConceptId: text(
      input.visualConceptId,
      `${field}.visualConceptId`,
      { max: 80, pattern: ID_PATTERN },
    ),
    headline: text(input.headline, `${field}.headline`, { max: 120 }),
    detail: text(input.detail, `${field}.detail`, { max: 160 }),
    sourceSceneId: text(input.sourceSceneId, `${field}.sourceSceneId`, {
      max: 80,
      pattern: ID_PATTERN,
    }),
    sourceOperationIndexes,
    geometry,
  };
}

function normalizeIntent(input, index) {
  const field = `visualIntentGraph.intents[${index}]`;
  exactKeys(input, [
    "id",
    "beatId",
    "role",
    "segmentIndex",
    "claimIds",
    "certainty",
    "wordSpan",
    "entityId",
    "eventKind",
    "semanticPredicate",
    "polarity",
    "epistemicStatus",
    "visualIntent",
    "visualAction",
    "sourceSceneId",
    "sourceOperationKinds",
    "primitivePayload",
  ], field);
  const role = text(input.role, `${field}.role`, { max: 20, pattern: ID_PATTERN });
  if (!SEMANTIC_SENTENCE_ROLES.includes(role)) fail(`${field}.role`, "unsupported_value");
  let visualIntent;
  try {
    visualIntent = normalizeVisualCapabilityProposition(input.visualIntent);
  } catch (error) {
    fail(`${field}.visualIntent`, error?.details?.reason || "unsupported_visual_intent");
  }
  const supportedAssets = compatibleAssetsForProposition(visualIntent)
    .filter((assetId) => SEMANTIC_SENTENCE_RENDERER_ASSET_IDS.includes(assetId));
  const supportedGrammars = compatibleGrammarsForProposition(visualIntent)
    .filter((grammarId) => SEMANTIC_SENTENCE_RENDERER_GRAMMAR_IDS.includes(grammarId));
  if (!supportedAssets.length) fail(`${field}.visualIntent`, "renderer_asset_unavailable");
  if (!supportedGrammars.length) fail(`${field}.visualIntent`, "renderer_grammar_unavailable");
  if (!supportedGrammars.some((grammarId) => (
    supportedAssets.some((assetId) => (
      SEMANTIC_SENTENCE_RENDERER_CAPABILITY_PAIRS.includes(
        `${grammarId}:${assetId}`,
      )
    ))
  ))) fail(`${field}.visualIntent`, "renderer_asset_grammar_pair_unavailable");
  return {
    id: text(input.id, `${field}.id`, { max: 120, pattern: ID_PATTERN }),
    beatId: text(input.beatId, `${field}.beatId`, { max: 80, pattern: ID_PATTERN }),
    role,
    segmentIndex: integer(input.segmentIndex, `${field}.segmentIndex`, 0, 3),
    claimIds: stringList(input.claimIds, `${field}.claimIds`, {
      minimum: 1,
      maximum: 4,
      pattern: CLAIM_ID_PATTERN,
    }),
    certainty: CERTAINTIES.includes(input.certainty)
      ? input.certainty
      : fail(`${field}.certainty`, "unsupported_value"),
    wordSpan: normalizeWordSpan(input.wordSpan, `${field}.wordSpan`),
    entityId: text(input.entityId, `${field}.entityId`, { max: 120, pattern: ID_PATTERN }),
    eventKind: EVENT_KINDS.includes(input.eventKind)
      ? input.eventKind
      : fail(`${field}.eventKind`, "unsupported_value"),
    semanticPredicate: text(input.semanticPredicate, `${field}.semanticPredicate`, {
      max: 80,
      pattern: ID_PATTERN,
    }),
    polarity: ["affirmed", "negated"].includes(input.polarity)
      ? input.polarity
      : fail(`${field}.polarity`, "unsupported_value"),
    epistemicStatus: EPISTEMIC_STATUSES.includes(input.epistemicStatus)
      ? input.epistemicStatus
      : fail(`${field}.epistemicStatus`, "unsupported_value"),
    visualIntent,
    visualAction: text(input.visualAction, `${field}.visualAction`, {
      max: 80,
      pattern: ID_PATTERN,
    }),
    sourceSceneId: text(input.sourceSceneId, `${field}.sourceSceneId`, {
      max: 80,
      pattern: ID_PATTERN,
    }),
    sourceOperationKinds: stringList(
      input.sourceOperationKinds,
      `${field}.sourceOperationKinds`,
      { minimum: 1, maximum: 12, pattern: ID_PATTERN },
    ),
    primitivePayload: normalizePrimitivePayload(
      input.primitivePayload,
      `${field}.primitivePayload`,
    ),
  };
}

function normalizeContinuity(input, index) {
  const field = `visualIntentGraph.continuity[${index}]`;
  exactKeys(input, ["entityId", "beatIds", "rule"], field);
  return {
    entityId: text(input.entityId, `${field}.entityId`, { max: 120, pattern: ID_PATTERN }),
    beatIds: stringList(input.beatIds, `${field}.beatIds`, {
      minimum: 2,
      maximum: 5,
      pattern: ID_PATTERN,
    }),
    rule: text(input.rule, `${field}.rule`, { max: 240 }),
  };
}

function normalizeVisualIntentGraph(input) {
  exactKeys(input, [
    "schemaVersion",
    "profileId",
    "storyFormat",
    "storyVocabulary",
    "narrativeShape",
    "bindings",
    "entities",
    "intents",
    "continuity",
  ], "visualIntentGraph", ["contentHash"]);
  if (input.schemaVersion !== VISUAL_INTENT_GRAPH_SCHEMA_VERSION) {
    fail("visualIntentGraph.schemaVersion", "unsupported_schema");
  }
  if (input.profileId !== VISUAL_INTENT_GRAPH_PROFILE_ID) {
    fail("visualIntentGraph.profileId", "unsupported_profile");
  }
  const entities = Array.isArray(input.entities)
    ? input.entities.map(normalizeEntity)
    : fail("visualIntentGraph.entities", "array_required");
  const intents = Array.isArray(input.intents)
    ? input.intents.map(normalizeIntent)
    : fail("visualIntentGraph.intents", "array_required");
  const continuity = Array.isArray(input.continuity)
    ? input.continuity.map(normalizeContinuity)
    : fail("visualIntentGraph.continuity", "array_required");
  if (!entities.length || entities.length > 20) fail("visualIntentGraph.entities", "array_size_invalid");
  if (
    intents.length < SEMANTIC_SENTENCE_ROLES.length
    || intents.length > 20
  ) {
    fail("visualIntentGraph.intents", "intent_count_invalid");
  }
  if (new Set(entities.map((entity) => entity.id)).size !== entities.length) {
    fail("visualIntentGraph.entities", "duplicate_ids");
  }
  if (new Set(intents.map((intent) => intent.id)).size !== intents.length) {
    fail("visualIntentGraph.intents", "duplicate_ids");
  }
  let previousRoleIndex = -1;
  const nextSegmentByBeatId = new Map();
  const priorSpanByBeatId = new Map();
  for (const [index, intent] of intents.entries()) {
    const roleIndex = SEMANTIC_SENTENCE_ROLES.indexOf(intent.role);
    const nextSegment = nextSegmentByBeatId.get(intent.beatId) || 0;
    if (
      roleIndex < previousRoleIndex
      || intent.segmentIndex !== nextSegment
      || intent.id !== `intent_${intent.beatId}_${intent.segmentIndex}`
    ) fail(`visualIntentGraph.intents[${index}]`, "intent_order_or_identity_invalid");
    const priorSpan = priorSpanByBeatId.get(intent.beatId);
    if (priorSpan && (
      intent.wordSpan.startWordIndex !== priorSpan.endWordIndex
      || intent.wordSpan.startFrame < priorSpan.endFrame
    )) fail(`visualIntentGraph.intents[${index}].wordSpan`, "intent_spans_must_be_contiguous");
    previousRoleIndex = roleIndex;
    nextSegmentByBeatId.set(intent.beatId, nextSegment + 1);
    priorSpanByBeatId.set(intent.beatId, intent.wordSpan);
  }
  if (new Set(intents.map((intent) => intent.role)).size !== SEMANTIC_SENTENCE_ROLES.length) {
    fail("visualIntentGraph.intents", "every_story_role_required");
  }
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const intentsByEntityId = new Map();
  for (const [index, intent] of intents.entries()) {
    const entity = entityById.get(intent.entityId);
    if (!entity) fail(`visualIntentGraph.intents[${index}].entityId`, "entity_not_found");
    if (entity.subjectKind !== intent.visualIntent.subjectKind) {
      fail(`visualIntentGraph.intents[${index}].visualIntent`, "entity_subject_mismatch");
    }
    if (!intent.claimIds.some((claimId) => entity.claimIds.includes(claimId))) {
      fail(`visualIntentGraph.intents[${index}].claimIds`, "entity_claim_mismatch");
    }
    const entityIntents = intentsByEntityId.get(entity.id) || [];
    entityIntents.push(intent);
    intentsByEntityId.set(entity.id, entityIntents);
  }
  const continuityByEntityId = new Map();
  for (const [index, binding] of continuity.entries()) {
    const entity = entityById.get(binding.entityId);
    const entityIntents = intentsByEntityId.get(binding.entityId) || [];
    const expectedBeatIds = [...new Set(entityIntents.map((intent) => intent.beatId))];
    if (!entity || !entity.persistent) {
      fail(`visualIntentGraph.continuity[${index}].entityId`, "persistent_entity_required");
    }
    if (continuityByEntityId.has(binding.entityId)) {
      fail(`visualIntentGraph.continuity[${index}].entityId`, "duplicate_continuity_entity");
    }
    if (
      binding.beatIds.length !== expectedBeatIds.length
      || binding.beatIds.some((beatId, beatIndex) => beatId !== expectedBeatIds[beatIndex])
    ) fail(`visualIntentGraph.continuity[${index}].beatIds`, "entity_beat_binding_mismatch");
    continuityByEntityId.set(binding.entityId, binding);
  }
  for (const [index, entity] of entities.entries()) {
    const entityIntents = intentsByEntityId.get(entity.id) || [];
    if (!entityIntents.length) fail(`visualIntentGraph.entities[${index}]`, "unreferenced_entity");
    const expectedPersistent = entityIntents.length > 1;
    const expectedClaims = [...new Set(entityIntents.flatMap((intent) => intent.claimIds))].sort();
    const expectedBeatIds = [...new Set(entityIntents.map((intent) => intent.beatId))];
    if (entity.persistent !== expectedPersistent) {
      fail(`visualIntentGraph.entities[${index}].persistent`, "intent_count_mismatch");
    }
    if (
      entity.claimIds.length !== expectedClaims.length
      || entity.claimIds.some((claimId, claimIndex) => claimId !== expectedClaims[claimIndex])
    ) fail(`visualIntentGraph.entities[${index}].claimIds`, "intent_claim_binding_mismatch");
    if (!expectedBeatIds.includes(entity.labelBeatId)) {
      fail(`visualIntentGraph.entities[${index}].labelBeatId`, "entity_beat_binding_mismatch");
    }
    if ((expectedBeatIds.length > 1) !== continuityByEntityId.has(entity.id)) {
      fail(`visualIntentGraph.entities[${index}].persistent`, "continuity_binding_mismatch");
    }
  }
  const storyVocabulary = text(input.storyVocabulary, "visualIntentGraph.storyVocabulary", {
    max: 80,
    pattern: ID_PATTERN,
  });
  if (!Object.hasOwn(NARRATIVE_SHAPE_BY_VOCABULARY, storyVocabulary)) {
    fail("visualIntentGraph.storyVocabulary", "unsupported_value");
  }
  const normalized = {
    schemaVersion: VISUAL_INTENT_GRAPH_SCHEMA_VERSION,
    profileId: VISUAL_INTENT_GRAPH_PROFILE_ID,
    storyFormat: input.storyFormat === "documented_mystery_v1"
      ? input.storyFormat
      : fail("visualIntentGraph.storyFormat", "unsupported_story_format"),
    storyVocabulary,
    narrativeShape: input.narrativeShape === NARRATIVE_SHAPE_BY_VOCABULARY[storyVocabulary]
      ? input.narrativeShape
      : fail("visualIntentGraph.narrativeShape", "vocabulary_shape_mismatch"),
    bindings: normalizeBindings(input.bindings),
    entities,
    intents,
    continuity,
  };
  const hash = contentHash(normalized);
  if (input.contentHash !== undefined && input.contentHash !== hash) {
    fail("visualIntentGraph.contentHash", "content_hash_mismatch");
  }
  return deepFreeze({ ...normalized, contentHash: hash });
}

function epistemicStatus(certainty) {
  if (certainty === "verified") return "supported_fact";
  if (certainty === "qualified") return "qualified_analysis";
  return "unknown";
}

function expectedVisualIntentGraph(storyIR) {
  const blueprints = INTENT_BLUEPRINTS[storyIR.storyVocabulary];
  if (!blueprints) fail("storyIR.storyVocabulary", "unsupported_value");
  const planned = [];
  const usesByEntityKey = new Map();
  for (const beat of storyIR.beats) {
    for (const [segmentIndex, segment] of beat.segments.entries()) {
      const selected = selectIntentBlueprint(
        storyIR,
        beat,
        segment,
        segmentIndex,
        planned.map(({ selected: recent }) => recent.visualConceptId),
      );
      if (!selected) fail(`storyIR.beats.${beat.role}`, "intent_blueprint_missing");
      const use = { beat, segment, segmentIndex, selected };
      planned.push(use);
      const uses = usesByEntityKey.get(selected.entityKey) || [];
      uses.push(use);
      usesByEntityKey.set(selected.entityKey, uses);
    }
  }
  const entityIdByIntentKey = new Map();
  const continuity = [];
  const entities = [];
  for (const [entityKey, uses] of usesByEntityKey.entries()) {
    const claimIds = [...new Set(uses.flatMap(({ beat }) => beat.claimIds))].sort();
    if (claimIds.length <= 6) {
      const id = `entity_${entityKey}`;
      uses.forEach(({ beat, segmentIndex }) => (
        entityIdByIntentKey.set(`${beat.beatId}:${segmentIndex}`, id)
      ));
      entities.push({
        id,
        label: uses[0].beat.source.onScreenText,
        labelBeatId: uses[0].beat.beatId,
        subjectKind: uses[0].selected.visualIntent.subjectKind,
        persistent: uses.length > 1,
        claimIds,
      });
      const beatIds = [...new Set(uses.map(({ beat }) => beat.beatId))];
      if (beatIds.length > 1) continuity.push({
        entityId: id,
        beatIds,
        rule: "Preserve one grounded visual identity across every referenced narration beat.",
      });
      continue;
    }
    for (const { beat, segmentIndex, selected } of uses) {
      const id = `entity_${entityKey}_${beat.role}_${segmentIndex}`;
      entityIdByIntentKey.set(`${beat.beatId}:${segmentIndex}`, id);
      entities.push({
        id,
        label: beat.source.onScreenText,
        labelBeatId: beat.beatId,
        subjectKind: selected.visualIntent.subjectKind,
        persistent: false,
        claimIds: [...beat.claimIds].sort(),
      });
    }
  }
  entities.sort((left, right) => compareText(left.id, right.id));
  const intents = planned.map(({ beat, segment, segmentIndex, selected }) => ({
      id: `intent_${beat.beatId}_${segmentIndex}`,
      beatId: beat.beatId,
      role: beat.role,
      segmentIndex,
      claimIds: [...beat.claimIds],
      certainty: beat.certainty,
      wordSpan: structuredClone(segment),
      entityId: entityIdByIntentKey.get(`${beat.beatId}:${segmentIndex}`),
      eventKind: selected.eventKind,
      semanticPredicate: selected.semanticPredicate,
      polarity: selected.polarity,
      epistemicStatus: epistemicStatus(beat.certainty),
      visualIntent: structuredClone(selected.visualIntent),
      visualAction: `compose_${selected.visualIntent.predicate}`,
      sourceSceneId: beat.source.sceneId,
      sourceOperationKinds: [...beat.source.operationKinds],
      primitivePayload: {
        profileId: VISUAL_INTENT_PRIMITIVE_PAYLOAD_PROFILE_ID,
        visualConceptId: selected.visualConceptId,
        headline: beat.source.onScreenText,
        detail: segment.text,
        sourceSceneId: beat.source.sceneId,
        sourceOperationIndexes: [...beat.source.operationIndexes],
        geometry: structuredClone(beat.source.geometry),
      },
    }));
  continuity.sort((left, right) => compareText(left.entityId, right.entityId));
  return {
    schemaVersion: VISUAL_INTENT_GRAPH_SCHEMA_VERSION,
    profileId: VISUAL_INTENT_GRAPH_PROFILE_ID,
    storyFormat: storyIR.storyFormat,
    storyVocabulary: storyIR.storyVocabulary,
    narrativeShape: storyIR.narrativeShape,
    bindings: {
      storyIRHash: storyIR.contentHash,
      ...structuredClone(storyIR.bindings),
    },
    entities,
    intents,
    continuity,
  };
}

function buildVisualIntentGraph(input, context = {}) {
  const storyIR = validateStoryIRAgainstDraft(input, context);
  return normalizeVisualIntentGraph(expectedVisualIntentGraph(storyIR));
}

function validateVisualIntentGraphAgainstStoryIR(input, storyInput, context = {}) {
  const graph = normalizeVisualIntentGraph(input);
  const expected = buildVisualIntentGraph(storyInput, context);
  if (graph.contentHash !== expected.contentHash) {
    fail("visualIntentGraph", "story_ir_binding_mismatch");
  }
  return graph;
}

module.exports = {
  INTENT_BLUEPRINTS,
  VISUAL_INTENT_PRIMITIVE_PAYLOAD_PROFILE_ID,
  VISUAL_INTENT_GRAPH_PROFILE_ID,
  VISUAL_INTENT_GRAPH_SCHEMA_VERSION,
  buildVisualIntentGraph,
  normalizeVisualIntentGraph,
  validateVisualIntentGraphAgainstStoryIR,
  visualIntentGraphContentHash: contentHash,
};
