"use strict";

const SEMANTIC_SENTENCE_PROFILE_TOKEN = "semantic-v3";
const SEMANTIC_SENTENCE_PROFILE_ID = "dark_curiosity_semantic_sentences_v3";
const SEMANTIC_SENTENCE_PROFILE_VERSION = "1.3.0";
const SEMANTIC_SENTENCE_STYLE_VERSION = "3.0.0";
const SEMANTIC_SENTENCE_TEMPLATE_ID = "semantic_sentence_stage_v3";
const SEMANTIC_SENTENCE_TEMPLATE_VERSION = "3.0.0";
const SEMANTIC_SENTENCE_SCHEMA_VERSION = 3;
const SEMANTIC_SENTENCE_MAX_SENTENCES_PER_BEAT = 8;
const SEMANTIC_SENTENCE_MAX_CLAIMS_PER_BEAT = 8;
const SEMANTIC_SENTENCE_MAX_TOTAL_SENTENCES = 20;

const SEMANTIC_SENTENCE_RENDERER_ASSET_IDS = Object.freeze([
  "archive_record",
  "calendar_card",
  "finite_counter",
  "hypothesis_card",
  "mapping_table",
  "receiver_device",
  "timeline_axis",
  "uncertainty_boundary",
  "vessel",
  "witness_marker",
]);

const SEMANTIC_SENTENCE_RENDERER_GRAMMAR_IDS = Object.freeze([
  "before_after",
  "bounded_uncertainty",
  "cause_effect_chain",
  "chronology_accumulation",
  "evidence_inspection",
  "finite_cycle",
  "map_motion",
  "negative_space_absence",
  "side_by_side_comparison",
]);

const SEMANTIC_SENTENCE_RENDERER_GRAMMAR_ASSET_BINDINGS = Object.freeze({
  before_after: Object.freeze(["calendar_card"]),
  bounded_uncertainty: Object.freeze([
    "hypothesis_card",
    "uncertainty_boundary",
  ]),
  cause_effect_chain: Object.freeze([
    "calendar_card",
    "finite_counter",
    "mapping_table",
    "receiver_device",
  ]),
  chronology_accumulation: Object.freeze([
    "archive_record",
    "timeline_axis",
  ]),
  evidence_inspection: Object.freeze(["archive_record"]),
  finite_cycle: Object.freeze(["finite_counter"]),
  map_motion: Object.freeze(["vessel", "witness_marker"]),
  negative_space_absence: Object.freeze(["vessel"]),
  side_by_side_comparison: Object.freeze([
    "finite_counter",
    "hypothesis_card",
    "timeline_axis",
    "vessel",
  ]),
});

const SEMANTIC_SENTENCE_RENDERER_CAPABILITY_PAIRS = Object.freeze(
  Object.entries(SEMANTIC_SENTENCE_RENDERER_GRAMMAR_ASSET_BINDINGS)
    .flatMap(([grammarId, assetIds]) => (
      assetIds.map((assetId) => `${grammarId}:${assetId}`)
    )),
);

const SEMANTIC_SENTENCE_ROLES = Object.freeze([
  "hook",
  "context",
  "evidence",
  "turn",
  "payoff",
]);

const SEMANTIC_SENTENCE_RENDERER = Object.freeze({
  provider: "hyperframes_local",
  runtimeVersion: "0.7.55",
  styleVersion: SEMANTIC_SENTENCE_STYLE_VERSION,
});

module.exports = {
  SEMANTIC_SENTENCE_MAX_CLAIMS_PER_BEAT,
  SEMANTIC_SENTENCE_MAX_SENTENCES_PER_BEAT,
  SEMANTIC_SENTENCE_MAX_TOTAL_SENTENCES,
  SEMANTIC_SENTENCE_PROFILE_ID,
  SEMANTIC_SENTENCE_PROFILE_TOKEN,
  SEMANTIC_SENTENCE_PROFILE_VERSION,
  SEMANTIC_SENTENCE_RENDERER,
  SEMANTIC_SENTENCE_RENDERER_ASSET_IDS,
  SEMANTIC_SENTENCE_RENDERER_CAPABILITY_PAIRS,
  SEMANTIC_SENTENCE_RENDERER_GRAMMAR_ASSET_BINDINGS,
  SEMANTIC_SENTENCE_RENDERER_GRAMMAR_IDS,
  SEMANTIC_SENTENCE_ROLES,
  SEMANTIC_SENTENCE_SCHEMA_VERSION,
  SEMANTIC_SENTENCE_STYLE_VERSION,
  SEMANTIC_SENTENCE_TEMPLATE_ID,
  SEMANTIC_SENTENCE_TEMPLATE_VERSION,
};
