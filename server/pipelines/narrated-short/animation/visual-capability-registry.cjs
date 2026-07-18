"use strict";

const { AppError } = require("../../../errors.cjs");

const VISUAL_PREDICATE_FAMILIES = Object.freeze([
  "appearance",
  "bounded_uncertainty",
  "capacity_limit",
  "cause_effect",
  "comparison",
  "disappearance",
  "last_known_record",
  "mechanism_reveal",
  "misinterpretation",
  "movement",
  "negation",
  "recurrence",
  "remediation",
  "state_change",
]);

const VISUAL_SUBJECT_KINDS = Object.freeze([
  "date",
  "device",
  "environment",
  "evidence",
  "finite_counter",
  "hypothesis",
  "mapping",
  "numeric_value",
  "observer",
  "record",
  "route",
  "timeline",
  "unknown_region",
  "vessel",
]);

const COMPARISON_SUBJECT_KINDS = Object.freeze([
  "date",
  "device",
  "evidence",
  "finite_counter",
  "hypothesis",
  "mapping",
  "numeric_value",
  "record",
  "timeline",
  "vessel",
]);

const VISUAL_STATE_TRANSITIONS = Object.freeze([
  "accumulate_records",
  "become_absent",
  "become_visible",
  "change_value",
  "compare_states",
  "enter_unknown_region",
  "map_input_to_output",
  "map_to_incorrect_output",
  "mark_last_known",
  "move_along_path",
  "occlude_then_absent",
  "reach_capacity",
  "reject_hypothesis",
  "remain_unresolved",
  "repeat_cycle",
  "require_update",
  "reset_to_origin",
  "reveal_structure",
  "wrap_to_origin",
]);

const PREDICATE_CAPABILITIES = deepFreeze({
  appearance: {
    capabilities: [
      capability("appearance", ["evidence", "observer", "record", "vessel"], ["become_visible"]),
    ],
  },
  bounded_uncertainty: {
    capabilities: [
      capability("bounded_uncertainty", ["evidence", "hypothesis"], ["remain_unresolved"]),
      capability("bounded_uncertainty", ["route", "unknown_region", "vessel"], ["enter_unknown_region", "remain_unresolved"]),
    ],
  },
  capacity_limit: {
    capabilities: [
      capability("capacity_limit", ["finite_counter"], ["reach_capacity"]),
    ],
  },
  cause_effect: {
    capabilities: [
      capability("cause_effect", ["device", "evidence", "mapping"], ["map_input_to_output"]),
    ],
  },
  comparison: {
    capabilities: [
      capability("comparison", COMPARISON_SUBJECT_KINDS, ["compare_states"]),
    ],
  },
  disappearance: {
    capabilities: [
      capability("disappearance", ["evidence", "record"], ["become_absent"]),
      capability("disappearance", ["vessel"], ["become_absent", "occlude_then_absent"]),
    ],
  },
  last_known_record: {
    capabilities: [
      capability("last_known_record", ["evidence", "route", "vessel"], ["mark_last_known"]),
      capability("last_known_record", ["record", "timeline"], ["accumulate_records", "mark_last_known"]),
    ],
  },
  mechanism_reveal: {
    capabilities: [
      capability("mechanism_reveal", ["device", "finite_counter", "mapping"], ["reveal_structure"]),
    ],
  },
  misinterpretation: {
    capabilities: [
      capability("misinterpretation", ["date", "device", "mapping"], ["map_to_incorrect_output"]),
    ],
  },
  movement: {
    capabilities: [
      capability("movement", ["environment", "route", "vessel"], ["move_along_path"]),
    ],
  },
  negation: {
    capabilities: [
      capability("negation", ["evidence", "hypothesis"], ["reject_hypothesis"]),
    ],
  },
  recurrence: {
    capabilities: [
      capability("recurrence", ["evidence", "finite_counter", "record", "route", "timeline", "vessel"], ["repeat_cycle"]),
    ],
  },
  remediation: {
    capabilities: [
      capability("remediation", ["device", "mapping"], ["require_update"]),
    ],
  },
  state_change: {
    capabilities: [
      capability("state_change", ["date", "device", "numeric_value"], ["change_value"]),
      capability("state_change", ["finite_counter"], ["change_value", "reset_to_origin", "wrap_to_origin"]),
    ],
  },
});

const SEMANTIC_ASSET_CAPABILITIES = deepFreeze({
  archive_record: {
    semanticRole: "primary",
    capabilities: [
      capability("appearance", ["record"], ["become_visible"]),
      capability("comparison", ["record"], ["compare_states"]),
      capability("disappearance", ["record"], ["become_absent"]),
      capability("last_known_record", ["record"], ["accumulate_records", "mark_last_known"]),
      capability("recurrence", ["record"], ["repeat_cycle"]),
    ],
  },
  blizzard_mask: {
    semanticRole: "supporting",
    capabilities: [
      capability("disappearance", ["vessel"], ["occlude_then_absent"]),
    ],
  },
  calendar_card: {
    semanticRole: "primary",
    capabilities: [
      capability("comparison", ["date"], ["compare_states"]),
      capability("misinterpretation", ["date"], ["map_to_incorrect_output"]),
      capability("state_change", ["date"], ["change_value"]),
    ],
  },
  causal_connector: {
    semanticRole: "supporting",
    capabilities: [
      capability("cause_effect", ["device", "evidence", "mapping"], ["map_input_to_output"]),
      capability("misinterpretation", ["date", "device", "mapping"], ["map_to_incorrect_output"]),
      capability("mechanism_reveal", ["device", "finite_counter", "mapping"], ["reveal_structure"]),
      capability("remediation", ["device", "mapping"], ["require_update"]),
    ],
  },
  comparison_frame: {
    semanticRole: "supporting",
    capabilities: [
      capability("comparison", COMPARISON_SUBJECT_KINDS, ["compare_states"]),
    ],
  },
  evidence_node: {
    semanticRole: "primary",
    capabilities: [
      capability("appearance", ["evidence"], ["become_visible"]),
      capability("bounded_uncertainty", ["evidence"], ["remain_unresolved"]),
      capability("cause_effect", ["evidence"], ["map_input_to_output"]),
      capability("comparison", ["evidence"], ["compare_states"]),
      capability("disappearance", ["evidence"], ["become_absent"]),
      capability("last_known_record", ["evidence"], ["mark_last_known"]),
      capability("negation", ["evidence"], ["reject_hypothesis"]),
      capability("recurrence", ["evidence"], ["repeat_cycle"]),
    ],
  },
  finite_counter: {
    semanticRole: "primary",
    capabilities: [
      capability("capacity_limit", ["finite_counter"], ["reach_capacity"]),
      capability("comparison", ["finite_counter"], ["compare_states"]),
      capability("mechanism_reveal", ["finite_counter"], ["reveal_structure"]),
      capability("recurrence", ["finite_counter"], ["repeat_cycle"]),
      capability("state_change", ["finite_counter"], ["change_value", "reset_to_origin", "wrap_to_origin"]),
    ],
  },
  hypothesis_card: {
    semanticRole: "primary",
    capabilities: [
      capability("bounded_uncertainty", ["hypothesis"], ["remain_unresolved"]),
      capability("comparison", ["hypothesis"], ["compare_states"]),
      capability("negation", ["hypothesis"], ["reject_hypothesis"]),
    ],
  },
  mapping_table: {
    semanticRole: "primary",
    capabilities: [
      capability("cause_effect", ["mapping"], ["map_input_to_output"]),
      capability("comparison", ["mapping"], ["compare_states"]),
      capability("misinterpretation", ["mapping"], ["map_to_incorrect_output"]),
      capability("mechanism_reveal", ["mapping"], ["reveal_structure"]),
      capability("remediation", ["mapping"], ["require_update"]),
    ],
  },
  pack_ice: {
    semanticRole: "primary",
    capabilities: [
      capability("movement", ["environment"], ["move_along_path"]),
    ],
  },
  receiver_device: {
    semanticRole: "primary",
    capabilities: [
      capability("cause_effect", ["device"], ["map_input_to_output"]),
      capability("comparison", ["device"], ["compare_states"]),
      capability("misinterpretation", ["device"], ["map_to_incorrect_output"]),
      capability("mechanism_reveal", ["device"], ["reveal_structure"]),
      capability("remediation", ["device"], ["require_update"]),
      capability("state_change", ["device"], ["change_value"]),
    ],
  },
  route_map: {
    semanticRole: "primary",
    capabilities: [
      capability("bounded_uncertainty", ["route"], ["enter_unknown_region", "remain_unresolved"]),
      capability("last_known_record", ["route"], ["mark_last_known"]),
      capability("movement", ["route"], ["move_along_path"]),
      capability("recurrence", ["route"], ["repeat_cycle"]),
    ],
  },
  timeline_axis: {
    semanticRole: "primary",
    capabilities: [
      capability("comparison", ["timeline"], ["compare_states"]),
      capability("last_known_record", ["timeline"], ["accumulate_records", "mark_last_known"]),
      capability("recurrence", ["timeline"], ["repeat_cycle"]),
    ],
  },
  uncertainty_boundary: {
    semanticRole: "primary",
    capabilities: [
      capability("bounded_uncertainty", ["unknown_region"], ["enter_unknown_region", "remain_unresolved"]),
    ],
  },
  value_token: {
    semanticRole: "primary",
    capabilities: [
      capability("comparison", ["numeric_value"], ["compare_states"]),
      capability("state_change", ["numeric_value"], ["change_value"]),
    ],
  },
  vessel: {
    semanticRole: "primary",
    capabilities: [
      capability("appearance", ["vessel"], ["become_visible"]),
      capability("bounded_uncertainty", ["vessel"], ["enter_unknown_region", "remain_unresolved"]),
      capability("comparison", ["vessel"], ["compare_states"]),
      capability("disappearance", ["vessel"], ["become_absent", "occlude_then_absent"]),
      capability("last_known_record", ["vessel"], ["mark_last_known"]),
      capability("movement", ["vessel"], ["move_along_path"]),
      capability("recurrence", ["vessel"], ["repeat_cycle"]),
    ],
  },
  witness_marker: {
    semanticRole: "primary",
    capabilities: [
      capability("appearance", ["observer"], ["become_visible"]),
    ],
  },
});

const COMPOSITION_GRAMMAR_CAPABILITIES = deepFreeze({
  before_after: {
    capabilities: [
      capability("appearance", ["evidence", "record", "vessel"], ["become_visible"]),
      capability("comparison", COMPARISON_SUBJECT_KINDS, ["compare_states"]),
      capability("disappearance", ["evidence", "record"], ["become_absent"]),
      capability("disappearance", ["vessel"], ["become_absent", "occlude_then_absent"]),
      capability("state_change", ["date", "device", "numeric_value"], ["change_value"]),
      capability("state_change", ["finite_counter"], ["change_value", "reset_to_origin", "wrap_to_origin"]),
    ],
  },
  bounded_uncertainty: {
    capabilities: [
      capability("bounded_uncertainty", ["evidence", "hypothesis"], ["remain_unresolved"]),
      capability("bounded_uncertainty", ["route", "unknown_region", "vessel"], ["enter_unknown_region", "remain_unresolved"]),
      capability("last_known_record", ["evidence", "record", "route", "timeline", "vessel"], ["mark_last_known"]),
      capability("negation", ["evidence", "hypothesis"], ["reject_hypothesis"]),
    ],
  },
  cause_effect_chain: {
    capabilities: [
      capability("cause_effect", ["device", "evidence", "mapping"], ["map_input_to_output"]),
      capability("misinterpretation", ["date", "device", "mapping"], ["map_to_incorrect_output"]),
      capability("mechanism_reveal", ["device", "finite_counter", "mapping"], ["reveal_structure"]),
      capability("remediation", ["device", "mapping"], ["require_update"]),
    ],
  },
  chronology_accumulation: {
    capabilities: [
      capability("last_known_record", ["evidence", "route", "vessel"], ["mark_last_known"]),
      capability("last_known_record", ["record", "timeline"], ["accumulate_records", "mark_last_known"]),
      capability("recurrence", ["evidence", "record", "route", "timeline", "vessel"], ["repeat_cycle"]),
    ],
  },
  evidence_inspection: {
    capabilities: [
      capability("appearance", ["evidence", "record"], ["become_visible"]),
      capability("last_known_record", ["evidence", "record"], ["mark_last_known"]),
      capability("negation", ["evidence", "hypothesis"], ["reject_hypothesis"]),
    ],
  },
  finite_cycle: {
    capabilities: [
      capability("capacity_limit", ["finite_counter"], ["reach_capacity"]),
      capability("recurrence", ["finite_counter", "timeline"], ["repeat_cycle"]),
      capability("state_change", ["finite_counter"], ["reset_to_origin", "wrap_to_origin"]),
    ],
  },
  map_motion: {
    capabilities: [
      capability("appearance", ["observer", "vessel"], ["become_visible"]),
      capability("last_known_record", ["route", "vessel"], ["mark_last_known"]),
      capability("movement", ["environment", "route", "vessel"], ["move_along_path"]),
      capability("recurrence", ["route", "vessel"], ["repeat_cycle"]),
    ],
  },
  negative_space_absence: {
    capabilities: [
      capability("bounded_uncertainty", ["route", "unknown_region", "vessel"], ["enter_unknown_region", "remain_unresolved"]),
      capability("disappearance", ["evidence", "record"], ["become_absent"]),
      capability("disappearance", ["vessel"], ["become_absent", "occlude_then_absent"]),
      capability("negation", ["evidence", "hypothesis"], ["reject_hypothesis"]),
    ],
  },
  side_by_side_comparison: {
    capabilities: [
      capability("comparison", COMPARISON_SUBJECT_KINDS, ["compare_states"]),
      capability("misinterpretation", ["date", "device", "mapping"], ["map_to_incorrect_output"]),
      capability("negation", ["evidence", "hypothesis"], ["reject_hypothesis"]),
    ],
  },
  state_transition: {
    capabilities: [
      capability("appearance", ["evidence", "observer", "record", "vessel"], ["become_visible"]),
      capability("disappearance", ["evidence", "record"], ["become_absent"]),
      capability("disappearance", ["vessel"], ["become_absent", "occlude_then_absent"]),
      capability("state_change", ["date", "device", "numeric_value"], ["change_value"]),
      capability("state_change", ["finite_counter"], ["change_value", "reset_to_origin", "wrap_to_origin"]),
    ],
  },
});

function capability(predicate, subjectKinds, stateTransitions) {
  return {
    predicate,
    subjectKinds: [...subjectKinds].sort(),
    stateTransitions: [...stateTransitions].sort(),
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function fail(field, reason = "invalid", code = "ANIMATION_VISUAL_CAPABILITY_INVALID") {
  throw new AppError(
    code,
    "The semantic visual capability request is invalid or unsupported.",
    409,
    { field, reason },
  );
}

function exactKeys(value, allowed, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field, "object_required");
  const supported = new Set(allowed);
  for (const key of Object.keys(value)) if (!supported.has(key)) fail(`${field}.${key}`, "unsupported_field");
}

function id(value, field, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) fail(field, "unsupported_value");
  return value;
}

function stringList(value, field, allowed, options = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(field, "array_required");
  const normalized = value.map((entry, index) => id(entry, `${field}[${index}]`, allowed));
  if (!options.allowDuplicates && new Set(normalized).size !== normalized.length) {
    fail(field, "duplicates_not_allowed");
  }
  return normalized;
}

function normalizeVisualCapabilityProposition(input) {
  exactKeys(input, ["predicate", "subjectKind", "stateTransition"], "proposition");
  const normalized = {
    predicate: id(input.predicate, "proposition.predicate", VISUAL_PREDICATE_FAMILIES),
    subjectKind: id(input.subjectKind, "proposition.subjectKind", VISUAL_SUBJECT_KINDS),
    stateTransition: id(input.stateTransition, "proposition.stateTransition", VISUAL_STATE_TRANSITIONS),
  };
  const predicateCapabilities = PREDICATE_CAPABILITIES[normalized.predicate].capabilities;
  const subjectCompatible = predicateCapabilities.some((entry) => entry.subjectKinds.includes(normalized.subjectKind));
  if (!subjectCompatible) fail("proposition.subjectKind", "predicate_subject_incompatible");
  if (!capabilityMatches(predicateCapabilities, normalized)) {
    fail("proposition.stateTransition", "predicate_subject_transition_incompatible");
  }
  return Object.freeze(normalized);
}

function capabilityMatches(capabilities, proposition) {
  return capabilities.some((entry) => (
    entry.predicate === proposition.predicate
    && entry.subjectKinds.includes(proposition.subjectKind)
    && entry.stateTransitions.includes(proposition.stateTransition)
  ));
}

function assetSupportsProposition(assetId, input, options = {}) {
  const proposition = normalizeVisualCapabilityProposition(input);
  const asset = SEMANTIC_ASSET_CAPABILITIES[assetId];
  if (!asset) fail("assetId", "unknown_asset");
  exactKeys(options, ["semanticRole"], "options");
  const semanticRole = options.semanticRole || null;
  if (semanticRole !== null && !["primary", "supporting"].includes(semanticRole)) fail("options.semanticRole", "unsupported_value");
  return (!semanticRole || asset.semanticRole === semanticRole)
    && capabilityMatches(asset.capabilities, proposition);
}

function grammarSupportsProposition(grammarId, input) {
  const proposition = normalizeVisualCapabilityProposition(input);
  const grammar = COMPOSITION_GRAMMAR_CAPABILITIES[grammarId];
  if (!grammar) fail("grammarId", "unknown_grammar");
  return capabilityMatches(grammar.capabilities, proposition);
}

function compatibleAssetsForProposition(input, options = {}) {
  const proposition = normalizeVisualCapabilityProposition(input);
  exactKeys(options, ["semanticRole"], "options");
  const semanticRole = options.semanticRole === undefined ? "primary" : options.semanticRole;
  if (!["primary", "supporting", "any"].includes(semanticRole)) fail("options.semanticRole", "unsupported_value");
  return Object.freeze(Object.keys(SEMANTIC_ASSET_CAPABILITIES)
    .filter((assetId) => {
      const asset = SEMANTIC_ASSET_CAPABILITIES[assetId];
      return (semanticRole === "any" || asset.semanticRole === semanticRole)
        && capabilityMatches(asset.capabilities, proposition);
    })
    .sort());
}

function compatibleGrammarsForProposition(input) {
  const proposition = normalizeVisualCapabilityProposition(input);
  return Object.freeze(Object.keys(COMPOSITION_GRAMMAR_CAPABILITIES)
    .filter((grammarId) => capabilityMatches(COMPOSITION_GRAMMAR_CAPABILITIES[grammarId].capabilities, proposition))
    .sort());
}

function preferredGrammarForProposition(input) {
  const proposition = normalizeVisualCapabilityProposition(input);
  switch (proposition.predicate) {
    case "appearance":
      return ["observer", "vessel"].includes(proposition.subjectKind)
        ? "map_motion"
        : "evidence_inspection";
    case "bounded_uncertainty":
      return "bounded_uncertainty";
    case "capacity_limit":
      return "finite_cycle";
    case "cause_effect":
      return "cause_effect_chain";
    case "comparison":
      return "side_by_side_comparison";
    case "disappearance":
      return "negative_space_absence";
    case "last_known_record":
      return "chronology_accumulation";
    case "mechanism_reveal":
      return "cause_effect_chain";
    case "misinterpretation":
      return "cause_effect_chain";
    case "movement":
      return "map_motion";
    case "negation":
      return proposition.subjectKind === "evidence"
        ? "evidence_inspection"
        : "side_by_side_comparison";
    case "recurrence":
      if (proposition.subjectKind === "finite_counter") return "finite_cycle";
      if (["route", "vessel"].includes(proposition.subjectKind)) return "map_motion";
      return "chronology_accumulation";
    case "remediation":
      return "cause_effect_chain";
    case "state_change":
      return proposition.subjectKind === "finite_counter"
        && ["reset_to_origin", "wrap_to_origin"].includes(proposition.stateTransition)
        ? "finite_cycle"
        : "before_after";
    default:
      fail("proposition.predicate", "preferred_grammar_not_defined");
  }
}

function countOccurrences(values, target) {
  return values.reduce((count, value) => count + (value === target ? 1 : 0), 0);
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function scoreVisualCapabilityCandidate(input) {
  exactKeys(input, [
    "proposition",
    "assetId",
    "grammarId",
    "recentGrammarIds",
    "recentAssetIds",
    "carriedAssetIds",
  ], "candidate");
  const proposition = normalizeVisualCapabilityProposition(input.proposition);
  const assetIds = Object.keys(SEMANTIC_ASSET_CAPABILITIES);
  const grammarIds = Object.keys(COMPOSITION_GRAMMAR_CAPABILITIES);
  const assetId = id(input.assetId, "candidate.assetId", assetIds);
  const grammarId = id(input.grammarId, "candidate.grammarId", grammarIds);
  const recentGrammarIds = stringList(
    input.recentGrammarIds,
    "candidate.recentGrammarIds",
    grammarIds,
    { allowDuplicates: true },
  );
  const recentAssetIds = stringList(
    input.recentAssetIds,
    "candidate.recentAssetIds",
    assetIds,
    { allowDuplicates: true },
  );
  const carriedAssetIds = stringList(input.carriedAssetIds, "candidate.carriedAssetIds", assetIds);
  const assetCompatible = SEMANTIC_ASSET_CAPABILITIES[assetId].semanticRole === "primary"
    && capabilityMatches(SEMANTIC_ASSET_CAPABILITIES[assetId].capabilities, proposition);
  const grammarCompatible = capabilityMatches(COMPOSITION_GRAMMAR_CAPABILITIES[grammarId].capabilities, proposition);

  if (!assetCompatible || !grammarCompatible) {
    return Object.freeze({
      compatible: false,
      score: null,
      semanticScore: 0,
      continuityScore: 0,
      noveltyScore: 0,
      reasons: Object.freeze([
        ...(assetCompatible ? [] : ["asset_semantically_incompatible"]),
        ...(grammarCompatible ? [] : ["grammar_semantically_incompatible"]),
      ]),
    });
  }

  const continuityScore = carriedAssetIds.includes(assetId) ? 30 : 0;
  const sameGrammarCount = countOccurrences(recentGrammarIds, grammarId);
  const sameAssetCount = countOccurrences(recentAssetIds, assetId);
  const repeatedImmediately = recentGrammarIds.at(-1) === grammarId;
  const grammarNovelty = Math.max(0, 20 - sameGrammarCount * 5 - (repeatedImmediately ? 10 : 0));
  const assetNovelty = carriedAssetIds.includes(assetId)
    ? 0
    : Math.max(0, 10 - sameAssetCount * 3);
  const noveltyScore = grammarNovelty + assetNovelty;
  const preferredGrammarId = preferredGrammarForProposition(proposition);
  const semanticScore = grammarId === preferredGrammarId ? 200 : 100;

  return Object.freeze({
    compatible: true,
    score: semanticScore * 1_000 + continuityScore * 10 + noveltyScore,
    semanticScore,
    continuityScore,
    noveltyScore,
    reasons: Object.freeze([]),
  });
}

function selectVisualCapability(input) {
  exactKeys(input, [
    "proposition",
    "recentGrammarIds",
    "recentAssetIds",
    "carriedAssetIds",
    "excludedAssetIds",
    "excludedGrammarIds",
  ], "selection");
  const proposition = normalizeVisualCapabilityProposition(input.proposition);
  const assetIds = Object.keys(SEMANTIC_ASSET_CAPABILITIES);
  const grammarIds = Object.keys(COMPOSITION_GRAMMAR_CAPABILITIES);
  const recentGrammarIds = stringList(
    input.recentGrammarIds,
    "selection.recentGrammarIds",
    grammarIds,
    { allowDuplicates: true },
  );
  const recentAssetIds = stringList(
    input.recentAssetIds,
    "selection.recentAssetIds",
    assetIds,
    { allowDuplicates: true },
  );
  const carriedAssetIds = stringList(input.carriedAssetIds, "selection.carriedAssetIds", assetIds);
  const excludedAssetIds = new Set(stringList(input.excludedAssetIds, "selection.excludedAssetIds", assetIds));
  const excludedGrammarIds = new Set(stringList(input.excludedGrammarIds, "selection.excludedGrammarIds", grammarIds));
  const compatibleAssets = compatibleAssetsForProposition(proposition)
    .filter((assetId) => !excludedAssetIds.has(assetId));
  const compatibleGrammars = compatibleGrammarsForProposition(proposition)
    .filter((grammarId) => !excludedGrammarIds.has(grammarId));
  const candidates = [];

  for (const assetId of compatibleAssets) {
    for (const grammarId of compatibleGrammars) {
      const evaluation = scoreVisualCapabilityCandidate({
        proposition,
        assetId,
        grammarId,
        recentGrammarIds,
        recentAssetIds,
        carriedAssetIds,
      });
      if (evaluation.compatible) candidates.push({ assetId, grammarId, evaluation });
    }
  }

  candidates.sort((left, right) => (
    right.evaluation.score - left.evaluation.score
    || compareText(left.grammarId, right.grammarId)
    || compareText(left.assetId, right.assetId)
  ));
  const selected = candidates[0];
  if (!selected) {
    fail("selection", "no_semantically_compatible_candidate", "ANIMATION_VISUAL_CAPABILITY_UNSUPPORTED");
  }
  return Object.freeze({
    proposition,
    assetId: selected.assetId,
    grammarId: selected.grammarId,
    score: selected.evaluation.score,
    semanticScore: selected.evaluation.semanticScore,
    continuityScore: selected.evaluation.continuityScore,
    noveltyScore: selected.evaluation.noveltyScore,
  });
}

function validateVisualCapabilityRegistry() {
  const validateCapabilities = (registry, field, expectRole) => {
    for (const [entryId, entry] of Object.entries(registry)) {
      exactKeys(entry, expectRole ? ["semanticRole", "capabilities"] : ["capabilities"], `${field}.${entryId}`);
      if (expectRole && !["primary", "supporting"].includes(entry.semanticRole)) fail(`${field}.${entryId}.semanticRole`);
      if (!Array.isArray(entry.capabilities) || !entry.capabilities.length) fail(`${field}.${entryId}.capabilities`);
      const signatures = new Set();
      for (const [index, entryCapability] of entry.capabilities.entries()) {
        const capabilityField = `${field}.${entryId}.capabilities[${index}]`;
        exactKeys(entryCapability, ["predicate", "subjectKinds", "stateTransitions"], capabilityField);
        id(entryCapability.predicate, `${capabilityField}.predicate`, VISUAL_PREDICATE_FAMILIES);
        const subjects = stringList(entryCapability.subjectKinds, `${capabilityField}.subjectKinds`, VISUAL_SUBJECT_KINDS);
        const transitions = stringList(entryCapability.stateTransitions, `${capabilityField}.stateTransitions`, VISUAL_STATE_TRANSITIONS);
        if (!subjects.length || !transitions.length) fail(capabilityField, "empty_capability");
        const predicateCapabilities = PREDICATE_CAPABILITIES[entryCapability.predicate].capabilities;
        for (const subjectKind of subjects) {
          for (const stateTransition of transitions) {
            if (!capabilityMatches(predicateCapabilities, {
              predicate: entryCapability.predicate,
              subjectKind,
              stateTransition,
            })) fail(capabilityField, "predicate_subject_transition_incompatible");
          }
        }
        const signature = `${entryCapability.predicate}:${subjects.join(",")}:${transitions.join(",")}`;
        if (signatures.has(signature)) fail(capabilityField, "duplicate_capability");
        signatures.add(signature);
      }
    }
  };

  if (Object.keys(PREDICATE_CAPABILITIES).sort().join(",") !== [...VISUAL_PREDICATE_FAMILIES].sort().join(",")) {
    fail("PREDICATE_CAPABILITIES", "predicate_coverage_mismatch");
  }
  validateCapabilities(PREDICATE_CAPABILITIES, "PREDICATE_CAPABILITIES", false);
  validateCapabilities(SEMANTIC_ASSET_CAPABILITIES, "SEMANTIC_ASSET_CAPABILITIES", true);
  validateCapabilities(COMPOSITION_GRAMMAR_CAPABILITIES, "COMPOSITION_GRAMMAR_CAPABILITIES", false);
  for (const predicate of VISUAL_PREDICATE_FAMILIES) {
    const definition = PREDICATE_CAPABILITIES[predicate];
    for (const predicateCapability of definition.capabilities) {
      for (const subjectKind of predicateCapability.subjectKinds) {
        for (const stateTransition of predicateCapability.stateTransitions) {
          const proposition = { predicate, subjectKind, stateTransition };
          const assetCount = compatibleAssetsForProposition(proposition).length;
          const compatibleGrammars = compatibleGrammarsForProposition(proposition);
          const grammarCount = compatibleGrammars.length;
          if (!assetCount || !grammarCount) {
            fail(
              `PREDICATE_CAPABILITIES.${predicate}.${subjectKind}.${stateTransition}`,
              !assetCount ? "primary_asset_coverage_missing" : "grammar_coverage_missing",
            );
          }
          if (!compatibleGrammars.includes(preferredGrammarForProposition(proposition))) {
            fail(
              `PREDICATE_CAPABILITIES.${predicate}.${subjectKind}.${stateTransition}`,
              "preferred_grammar_incompatible",
            );
          }
        }
      }
    }
  }
  return true;
}

validateVisualCapabilityRegistry();

module.exports = {
  COMPOSITION_GRAMMAR_CAPABILITIES,
  PREDICATE_CAPABILITIES,
  SEMANTIC_ASSET_CAPABILITIES,
  VISUAL_PREDICATE_FAMILIES,
  VISUAL_STATE_TRANSITIONS,
  VISUAL_SUBJECT_KINDS,
  assetSupportsProposition,
  compatibleAssetsForProposition,
  compatibleGrammarsForProposition,
  grammarSupportsProposition,
  normalizeVisualCapabilityProposition,
  preferredGrammarForProposition,
  scoreVisualCapabilityCandidate,
  selectVisualCapability,
  validateVisualCapabilityRegistry,
};
