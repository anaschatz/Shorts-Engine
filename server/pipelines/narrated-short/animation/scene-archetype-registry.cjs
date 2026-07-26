"use strict";

const ARCHETYPE_IDS = Object.freeze([
  "document_record_v2",
  "evidence_card_v2",
  "relationship_graph_v2",
  "map_route_v2",
  "timeline_compare_v2",
  "scale_compare_v2",
  "bounded_verdict_v2",
]);

const STORY_VOCABULARIES = Object.freeze([
  "temporal_anomaly",
  "maritime_route",
  "radio_signal",
  "general_mystery",
]);

const ARCHETYPE_REGISTRY = Object.freeze({
  document_record_v2: Object.freeze({
    templates: Object.freeze(["hook_scene"]),
    operationTypes: Object.freeze(["set_heading", "show_evidence", "show_source_badge"]),
  }),
  evidence_card_v2: Object.freeze({
    templates: Object.freeze(["evidence_scene"]),
    operationTypes: Object.freeze(["show_evidence", "show_source_badge", "highlight_region"]),
  }),
  relationship_graph_v2: Object.freeze({
    templates: Object.freeze(["system_scale_scene"]),
    operationTypes: Object.freeze(["connect_nodes", "place_marker", "show_evidence"]),
  }),
  map_route_v2: Object.freeze({
    templates: Object.freeze(["map_timeline_scene"]),
    operationTypes: Object.freeze(["draw_route", "place_marker", "highlight_region", "reveal_layer"]),
  }),
  timeline_compare_v2: Object.freeze({
    templates: Object.freeze(["map_timeline_scene"]),
    operationTypes: Object.freeze(["advance_timeline", "place_marker", "reveal_layer"]),
  }),
  scale_compare_v2: Object.freeze({
    templates: Object.freeze(["system_scale_scene"]),
    operationTypes: Object.freeze(["compare_scale", "highlight_region", "show_evidence"]),
  }),
  bounded_verdict_v2: Object.freeze({
    templates: Object.freeze(["payoff_scene"]),
    operationTypes: Object.freeze(["show_uncertainty", "set_heading", "show_evidence"]),
  }),
});

const EXPLICIT_OPERATION_ARCHETYPES = Object.freeze({
  draw_route: "map_route_v2",
  advance_timeline: "timeline_compare_v2",
  compare_scale: "scale_compare_v2",
  connect_nodes: "relationship_graph_v2",
});

const TEMPLATE_DEFAULTS = Object.freeze({
  hook_scene: "document_record_v2",
  evidence_scene: "evidence_card_v2",
  system_scale_scene: "relationship_graph_v2",
  map_timeline_scene: "timeline_compare_v2",
  payoff_scene: "bounded_verdict_v2",
});

function operationText(operation) {
  return [
    operation.op,
    operation.id,
    operation.fromId,
    operation.toId,
    operation.text,
    operation.label,
    operation.date,
    operation.leftLabel,
    operation.rightLabel,
  ].filter(Boolean).join(" ").toLowerCase();
}

function sceneText(scene) {
  return scene.operations.map(operationText).join(" ");
}

function storyboardText(storyboard) {
  return storyboard.scenes.map(sceneText).join(" ");
}

function normalizedTerms(value) {
  return ` ${String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

function hasAny(value, terms) {
  const haystack = normalizedTerms(value);
  return terms.some((term) => haystack.includes(normalizedTerms(term)));
}

function classifyStoryVocabulary(storyboard) {
  const operations = storyboard.scenes.flatMap((scene) => scene.operations);
  const structuralText = operations.map((operation) => [
    operation.id,
    operation.fromId,
    operation.toId,
  ].filter(Boolean).join(" ").toLowerCase()).join(" ");
  const allText = storyboard.scenes.map(sceneText).join(" ");

  if (
    operations.some((operation) => operation.op === "draw_route")
    || hasAny(structuralText, ["harbor", "harbour", "lighthouse", "vessel", "ship", "maritime", "port", "beacon"])
    || hasAny(allText, ["harbor", "harbour", "lighthouse", "vessel", "ship", "maritime", "port", "beacon", "breakwater"])
  ) return "maritime_route";

  if (
    hasAny(structuralText, ["clock", "calendar", "timestamp", "timecode"])
    || hasAny(allText, ["timestamp", "time stamp", "tomorrow", "dated ahead", "future date", "calendar"])
  ) return "temporal_anomaly";

  if (
    hasAny(structuralText, ["telescope", "antenna", "receiver", "radio", "frequency"])
    || hasAny(allText, ["radio signal", "frequency", "telescope", "transmission", "astronomer"])
  ) return "radio_signal";

  return "general_mystery";
}

function inferStoryEntityKind(storyboard, storyVocabulary) {
  if (storyVocabulary !== "maritime_route") return null;
  const text = storyboardText(storyboard);
  const hasArcticSetting = hasAny(text, [
    "arctic",
    "pack ice",
    "pack_ice",
    "icebound",
    "ice bound",
    "blizzard",
  ]);
  const hasDriftingVessel = hasAny(text, [
    "abandoned ship",
    "baychimo",
    "crewless",
    "drift",
    "ship without a crew",
    "steamer",
  ]);
  return hasArcticSetting && hasDriftingVessel ? "arctic_drift" : null;
}

function resolveSceneArchetype(scene, storyVocabulary = "general_mystery") {
  const operationTypes = new Set(scene.operations.map((operation) => operation.op));

  for (const operationType of ["draw_route", "advance_timeline", "compare_scale", "connect_nodes"]) {
    if (operationTypes.has(operationType)) return EXPLICIT_OPERATION_ARCHETYPES[operationType];
  }

  if (scene.template === "map_timeline_scene" && (operationTypes.has("place_marker") || operationTypes.has("reveal_layer"))) {
    return storyVocabulary === "maritime_route" ? "map_route_v2" : "timeline_compare_v2";
  }
  if (scene.template === "system_scale_scene" && operationTypes.has("highlight_region")) {
    return storyVocabulary === "general_mystery" ? "scale_compare_v2" : "relationship_graph_v2";
  }
  return TEMPLATE_DEFAULTS[scene.template] || (
    operationTypes.has("show_uncertainty") ? "bounded_verdict_v2"
      : operationTypes.has("show_evidence") ? "evidence_card_v2"
        : operationTypes.has("set_heading") ? "document_record_v2"
          : null
  );
}

function sourceOperationIndexes(scene, archetypeId) {
  const definition = ARCHETYPE_REGISTRY[archetypeId];
  if (!definition) return [];
  const allowed = new Set(definition.operationTypes);
  return scene.operations
    .map((operation, index) => allowed.has(operation.op) ? index : null)
    .filter((index) => index !== null);
}

function inferEntityKind(scene, archetypeId, storyVocabulary, storyEntityKind = null) {
  if (
    storyEntityKind === "arctic_drift"
    && ["document_record_v2", "relationship_graph_v2", "map_route_v2"].includes(archetypeId)
  ) return "arctic_drift";
  if (archetypeId === "document_record_v2") return "document_record";
  if (archetypeId === "evidence_card_v2") return "evidence_record";
  if (archetypeId === "bounded_verdict_v2") return "bounded_verdict";
  if (archetypeId === "map_route_v2") return "maritime_route";
  if (archetypeId === "timeline_compare_v2") return "timeline";
  if (archetypeId === "scale_compare_v2") return "scale_comparison";
  if (archetypeId === "relationship_graph_v2") {
    if (storyVocabulary === "temporal_anomaly") return "clock";
    if (storyVocabulary === "maritime_route") return "maritime_route";
    if (storyVocabulary === "radio_signal") return "radio_signal";
    return "relationship";
  }
  return null;
}

module.exports = {
  ARCHETYPE_IDS,
  ARCHETYPE_REGISTRY,
  STORY_VOCABULARIES,
  classifyStoryVocabulary,
  inferEntityKind,
  inferStoryEntityKind,
  resolveSceneArchetype,
  sourceOperationIndexes,
};
