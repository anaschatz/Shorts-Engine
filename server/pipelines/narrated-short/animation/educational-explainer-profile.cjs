"use strict";

const { AppError } = require("../../../errors.cjs");
const { contentHash } = require("../contracts.cjs");

const EDUCATIONAL_EXPLAINER_PROFILE_TOKEN = "educational-explainer-v1";
const EDUCATIONAL_EXPLAINER_PROFILE_ID = "educational_explainer_v1";
const EDUCATIONAL_EXPLAINER_PROFILE_VERSION = "1.4.0";
const EDUCATIONAL_EXPLAINER_STYLE_VERSION = "4.0.0";
const EDUCATIONAL_EXPLAINER_TEMPLATE_ID = "educational_explainer_stage_v1";
const EDUCATIONAL_EXPLAINER_TEMPLATE_VERSION = "1.0.0";
const EDUCATIONAL_EXPLAINER_SCHEMA_VERSION = 4;
const REFERENCE_STYLE_SPEC_ID = "educational_line_art_reference_v1";
const REFERENCE_STYLE_SPEC_VERSION = "1.0.0";
const NARRATIVE_BEAT_GRAPH_PROFILE = "narrative_beat_graph_v1";
const DIRECTOR_PLAN_PROFILE = "educational_director_plan_v1";
const AUDIO_IR_PROFILE = "educational_audio_ir_v1";
const ASSET_MANIFEST_PROFILE = "educational_asset_manifest_v2";
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z][a-z0-9_-]{2,79}$/;

const EDUCATIONAL_EXPLAINER_RENDERER = Object.freeze({
  provider: "hyperframes_local",
  runtimeVersion: "0.7.55",
  styleVersion: EDUCATIONAL_EXPLAINER_STYLE_VERSION,
});

const EDUCATIONAL_LAYOUTS = Object.freeze([
  "overview_grid",
  "diagram_focus",
  "split_explain",
  "story_scene",
  "cta_network",
]);

const EDUCATIONAL_RECIPES = Object.freeze([
  "line_chart",
  "branching_tree",
  "process_flow",
  "evidence_lens",
  "timeline",
  "comparison",
  "map_route",
  "counter",
  "formula",
  "story_scene",
]);

const EDUCATIONAL_TRANSITIONS = Object.freeze([
  "draw_reveal",
  "match_morph",
  "focus_lens",
  "mask_wipe",
  "scale_focus",
]);

const GRAMMAR_RECIPE = Object.freeze({
  before_after: "comparison",
  bounded_uncertainty: "formula",
  cause_effect_chain: "process_flow",
  chronology_accumulation: "timeline",
  evidence_inspection: "evidence_lens",
  finite_cycle: "counter",
  map_motion: "map_route",
  negative_space_absence: "story_scene",
  side_by_side_comparison: "comparison",
});

const ROLE_MICROBEAT = Object.freeze({
  hook: "setup",
  context: "setup",
  evidence: "mechanism",
  turn: "example",
  payoff: "payoff",
});

function invalid(field, reason = "invalid") {
  throw new AppError(
    "EDUCATIONAL_EXPLAINER_CONTRACT_INVALID",
    "The educational explainer contract is invalid.",
    400,
    { field, reason },
  );
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value;
}

function exact(value, keys, field) {
  const allowed = new Set(keys);
  for (const key of Object.keys(object(value, field))) {
    if (!allowed.has(key)) invalid(`${field}.${key}`, "unsupported_field");
  }
}

function text(value, field, maximum = 160, pattern = null) {
  if (
    typeof value !== "string"
    || !value
    || value.length > maximum
    || /[\u0000-\u001f]/.test(value)
    || (pattern && !pattern.test(value))
  ) invalid(field);
  return value;
}

function integer(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) invalid(field);
  return value;
}

function number(value, field, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) invalid(field);
  return value;
}

function hash(value, field) {
  return text(value, field, 64, HASH_RE);
}

function array(value, field, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid(field);
  return value;
}

function withContentHash(value) {
  const normalized = structuredClone(value);
  delete normalized.contentHash;
  return Object.freeze({
    ...normalized,
    contentHash: contentHash(normalized),
  });
}

function assertContentHash(value, field) {
  const supplied = hash(value.contentHash, `${field}.contentHash`);
  const copy = structuredClone(value);
  delete copy.contentHash;
  if (contentHash(copy) !== supplied) invalid(`${field}.contentHash`, "hash_mismatch");
}

function defaultReferenceStyleSpec() {
  return withContentHash({
    schemaVersion: 1,
    id: REFERENCE_STYLE_SPEC_ID,
    profile: "educational_line_art",
    version: REFERENCE_STYLE_SPEC_VERSION,
    benchmarkRef: "instagram_dzt2g_htwco",
    canvas: {
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      fps: 30,
    },
    palette: {
      background: "#030303",
      primary: "#f8fafc",
      muted: "#94a3b8",
      accent: "#a78bfa",
      signal: "#ef4444",
      support: "#60a5fa",
    },
    regions: {
      persistentHeader: { top: 0.07, bottom: 0.19 },
      semanticStage: { top: 0.22, bottom: 0.76 },
      semanticPhrase: { top: 0.76, bottom: 0.89 },
      platformSafeBottom: 0.91,
    },
    typography: {
      promise: { family: "Outfit", weight: 600, size: 70, maxLines: 2 },
      section: { family: "Outfit", weight: 700, size: 56, maxLines: 2 },
      phrase: { family: "Outfit", weight: 500, size: 38, maxLines: 2 },
      label: { family: "Outfit", weight: 500, size: 25, maxLines: 2 },
    },
    pacing: {
      overviewCompleteBySeconds: 3,
      firstSectionBySeconds: 6,
      meaningfulChangeMinSeconds: 1.5,
      meaningfulChangeMaxSeconds: 3,
      sectionMinSeconds: 8,
      sectionMaxSeconds: 24,
    },
    layouts: [...EDUCATIONAL_LAYOUTS],
    recipes: [...EDUCATIONAL_RECIPES],
    transitions: [...EDUCATIONAL_TRANSITIONS],
    captionPolicy: {
      mode: "integrated_semantic_with_ass_fallback",
      fullTranscriptArtifact: true,
      duplicateBurnedText: false,
    },
    audioPolicy: {
      finalIntegratedLufs: -16,
      truePeakDbtp: -1.5,
      musicBedEnabled: false,
      sparseSfxEnabled: true,
      maxSfxPerMicrobeat: 1,
    },
  });
}

function validateReferenceStyleSpec(input) {
  const value = structuredClone(object(input, "referenceStyleSpec"));
  exact(value, [
    "schemaVersion", "id", "profile", "version", "benchmarkRef", "canvas",
    "palette", "regions", "typography", "pacing", "layouts", "recipes",
    "transitions", "captionPolicy", "audioPolicy", "contentHash",
  ], "referenceStyleSpec");
  if (value.schemaVersion !== 1) invalid("referenceStyleSpec.schemaVersion");
  text(value.id, "referenceStyleSpec.id", 80, ID_RE);
  if (value.id !== REFERENCE_STYLE_SPEC_ID || value.profile !== "educational_line_art" || value.version !== REFERENCE_STYLE_SPEC_VERSION) invalid("referenceStyleSpec.profile");
  text(value.benchmarkRef, "referenceStyleSpec.benchmarkRef", 80, ID_RE);
  exact(value.canvas, ["aspectRatio", "width", "height", "fps"], "referenceStyleSpec.canvas");
  if (value.canvas.aspectRatio !== "9:16") invalid("referenceStyleSpec.canvas.aspectRatio");
  integer(value.canvas.width, "referenceStyleSpec.canvas.width", 720, 2160);
  integer(value.canvas.height, "referenceStyleSpec.canvas.height", 1280, 3840);
  if (value.canvas.height * 9 !== value.canvas.width * 16) invalid("referenceStyleSpec.canvas");
  integer(value.canvas.fps, "referenceStyleSpec.canvas.fps", 24, 60);
  exact(value.palette, ["background", "primary", "muted", "accent", "signal", "support"], "referenceStyleSpec.palette");
  for (const [key, color] of Object.entries(value.palette)) text(color, `referenceStyleSpec.palette.${key}`, 7, /^#[a-f0-9]{6}$/);
  exact(value.regions, ["persistentHeader", "semanticStage", "semanticPhrase", "platformSafeBottom"], "referenceStyleSpec.regions");
  for (const region of ["persistentHeader", "semanticStage", "semanticPhrase"]) {
    exact(value.regions[region], ["top", "bottom"], `referenceStyleSpec.regions.${region}`);
    number(value.regions[region].top, `referenceStyleSpec.regions.${region}.top`, 0, 1);
    number(value.regions[region].bottom, `referenceStyleSpec.regions.${region}.bottom`, value.regions[region].top, 1);
  }
  number(value.regions.platformSafeBottom, "referenceStyleSpec.regions.platformSafeBottom", 0.8, 1);
  exact(value.typography, ["promise", "section", "phrase", "label"], "referenceStyleSpec.typography");
  for (const role of Object.keys(value.typography)) {
    exact(value.typography[role], ["family", "weight", "size", "maxLines"], `referenceStyleSpec.typography.${role}`);
    text(value.typography[role].family, `referenceStyleSpec.typography.${role}.family`, 40);
    integer(value.typography[role].weight, `referenceStyleSpec.typography.${role}.weight`, 300, 900);
    integer(value.typography[role].size, `referenceStyleSpec.typography.${role}.size`, 16, 120);
    integer(value.typography[role].maxLines, `referenceStyleSpec.typography.${role}.maxLines`, 1, 3);
  }
  exact(value.pacing, ["overviewCompleteBySeconds", "firstSectionBySeconds", "meaningfulChangeMinSeconds", "meaningfulChangeMaxSeconds", "sectionMinSeconds", "sectionMaxSeconds"], "referenceStyleSpec.pacing");
  number(value.pacing.overviewCompleteBySeconds, "referenceStyleSpec.pacing.overviewCompleteBySeconds", 1, 5);
  number(value.pacing.firstSectionBySeconds, "referenceStyleSpec.pacing.firstSectionBySeconds", 2, 10);
  number(value.pacing.meaningfulChangeMinSeconds, "referenceStyleSpec.pacing.meaningfulChangeMinSeconds", 0.5, 4);
  number(value.pacing.meaningfulChangeMaxSeconds, "referenceStyleSpec.pacing.meaningfulChangeMaxSeconds", value.pacing.meaningfulChangeMinSeconds, 6);
  number(value.pacing.sectionMinSeconds, "referenceStyleSpec.pacing.sectionMinSeconds", 3, 30);
  number(value.pacing.sectionMaxSeconds, "referenceStyleSpec.pacing.sectionMaxSeconds", value.pacing.sectionMinSeconds, 45);
  array(value.layouts, "referenceStyleSpec.layouts", 3, EDUCATIONAL_LAYOUTS.length);
  if (value.layouts.some((entry) => !EDUCATIONAL_LAYOUTS.includes(entry))) invalid("referenceStyleSpec.layouts");
  array(value.recipes, "referenceStyleSpec.recipes", 5, EDUCATIONAL_RECIPES.length);
  if (value.recipes.some((entry) => !EDUCATIONAL_RECIPES.includes(entry))) invalid("referenceStyleSpec.recipes");
  array(value.transitions, "referenceStyleSpec.transitions", 3, EDUCATIONAL_TRANSITIONS.length);
  if (value.transitions.some((entry) => !EDUCATIONAL_TRANSITIONS.includes(entry))) invalid("referenceStyleSpec.transitions");
  exact(value.captionPolicy, ["mode", "fullTranscriptArtifact", "duplicateBurnedText"], "referenceStyleSpec.captionPolicy");
  if (value.captionPolicy.mode !== "integrated_semantic_with_ass_fallback" || value.captionPolicy.fullTranscriptArtifact !== true || value.captionPolicy.duplicateBurnedText !== false) invalid("referenceStyleSpec.captionPolicy");
  exact(value.audioPolicy, ["finalIntegratedLufs", "truePeakDbtp", "musicBedEnabled", "sparseSfxEnabled", "maxSfxPerMicrobeat"], "referenceStyleSpec.audioPolicy");
  number(value.audioPolicy.finalIntegratedLufs, "referenceStyleSpec.audioPolicy.finalIntegratedLufs", -24, -12);
  number(value.audioPolicy.truePeakDbtp, "referenceStyleSpec.audioPolicy.truePeakDbtp", -3, -1);
  if (typeof value.audioPolicy.musicBedEnabled !== "boolean" || typeof value.audioPolicy.sparseSfxEnabled !== "boolean") invalid("referenceStyleSpec.audioPolicy");
  integer(value.audioPolicy.maxSfxPerMicrobeat, "referenceStyleSpec.audioPolicy.maxSfxPerMicrobeat", 0, 2);
  assertContentHash(value, "referenceStyleSpec");
  return Object.freeze(value);
}

function buildEducationalAssetManifest() {
  const definitions = [
    ["outfit_font", "font", "licensed_local", "outfit_600_ofl_v1"],
    ["line_person", "svg_primitive", "generated_by_engine", "person_head_body_limbs_v1"],
    ["line_chart", "svg_primitive", "generated_by_engine", "axes_points_trend_v1"],
    ["line_arrow", "svg_primitive", "generated_by_engine", "connector_arrow_v1"],
    ["line_database", "svg_primitive", "generated_by_engine", "database_stack_v1"],
    ["line_network", "svg_primitive", "generated_by_engine", "hub_spoke_network_v1"],
    ["line_formula", "svg_primitive", "generated_by_engine", "formula_panel_v1"],
    ["line_focus_lens", "svg_primitive", "generated_by_engine", "focus_lens_v1"],
    ["sfx_soft_tick", "generated_audio", "generated_by_engine", "sine_tick_880hz_v1"],
    ["sfx_soft_whoosh", "generated_audio", "generated_by_engine", "filtered_noise_whoosh_v1"],
  ];
  return withContentHash({
    schemaVersion: 2,
    profile: ASSET_MANIFEST_PROFILE,
    profileVersion: "2.0.0",
    assets: definitions.map(([id, type, origin, definition]) => ({
      id,
      type,
      origin,
      fileHash: contentHash({ id, definition }),
      licenseId: origin === "licensed_local" ? "sil_ofl_1_1" : "first_party_engine_generated",
      commercialUseAllowed: true,
      allowedUsage: ["short_form_video"],
      definition,
    })),
  });
}

function validateEducationalAssetManifest(input) {
  const value = structuredClone(object(input, "assetManifest"));
  exact(value, ["schemaVersion", "profile", "profileVersion", "assets", "contentHash"], "assetManifest");
  if (value.schemaVersion !== 2 || value.profile !== ASSET_MANIFEST_PROFILE || value.profileVersion !== "2.0.0") invalid("assetManifest.profile");
  const ids = new Set();
  array(value.assets, "assetManifest.assets", 8, 40).forEach((asset, index) => {
    const field = `assetManifest.assets[${index}]`;
    exact(asset, ["id", "type", "origin", "fileHash", "licenseId", "commercialUseAllowed", "allowedUsage", "definition"], field);
    text(asset.id, `${field}.id`, 80, ID_RE);
    if (ids.has(asset.id)) invalid(`${field}.id`, "duplicate");
    ids.add(asset.id);
    if (!["font", "svg_primitive", "generated_audio"].includes(asset.type)) invalid(`${field}.type`);
    if (!["licensed_local", "generated_by_engine"].includes(asset.origin)) invalid(`${field}.origin`);
    hash(asset.fileHash, `${field}.fileHash`);
    text(asset.licenseId, `${field}.licenseId`, 80, ID_RE);
    if (asset.commercialUseAllowed !== true) invalid(`${field}.commercialUseAllowed`);
    if (JSON.stringify(asset.allowedUsage) !== JSON.stringify(["short_form_video"])) invalid(`${field}.allowedUsage`);
    text(asset.definition, `${field}.definition`, 120, ID_RE);
  });
  assertContentHash(value, "assetManifest");
  return Object.freeze(value);
}

function buildNarrativeBeatGraph({ draft, timingContext, sentencePlan }) {
  if (!draft || !timingContext || !sentencePlan) invalid("narrativeBeatGraph.source");
  const sentencesByBeat = new Map();
  for (const sentence of sentencePlan.sentences || []) {
    const values = sentencesByBeat.get(sentence.beatId) || [];
    values.push(sentence);
    sentencesByBeat.set(sentence.beatId, values);
  }
  const microbeats = [];
  const sections = draft.script.beats.map((beat, index) => {
    const timing = timingContext.beats[index];
    if (!timing || timing.beatId !== beat.id) invalid(`narrativeBeatGraph.sections[${index}]`, "timing_mismatch");
    const sentences = sentencesByBeat.get(beat.id) || [];
    const microbeatIds = sentences.map((sentence, sentenceIndex) => {
      const id = `micro_${beat.role}_${String(sentenceIndex + 1).padStart(2, "0")}`;
      microbeats.push({
        id,
        sectionId: `section_${beat.role}`,
        type: ROLE_MICROBEAT[beat.role] || "mechanism",
        sentenceId: sentence.id,
        startFrame: sentence.wordSpan.startFrame,
        endFrame: sentence.wordSpan.endFrame,
        wordStartIndex: sentence.wordSpan.startWordIndex,
        wordEndIndex: sentence.wordSpan.endWordIndex,
        semanticText: sentence.wordSpan.text,
      });
      return id;
    });
    return {
      id: `section_${beat.role}`,
      role: beat.role,
      beatId: beat.id,
      startFrame: index === 0 ? 0 : timing.startFrame,
      endFrame: index === draft.script.beats.length - 1
        ? timingContext.durationFrames
        : timingContext.beats[index + 1].startFrame,
      microbeatIds,
    };
  });
  return withContentHash({
    schemaVersion: 1,
    profile: NARRATIVE_BEAT_GRAPH_PROFILE,
    profileVersion: "1.0.0",
    draftHash: draft.contentHash,
    timingContextHash: timingContext.contentHash,
    durationFrames: timingContext.durationFrames,
    fps: timingContext.fps,
    sections,
    microbeats,
  });
}

function validateNarrativeBeatGraph(input) {
  const value = structuredClone(object(input, "narrativeBeatGraph"));
  exact(value, ["schemaVersion", "profile", "profileVersion", "draftHash", "timingContextHash", "durationFrames", "fps", "sections", "microbeats", "contentHash"], "narrativeBeatGraph");
  if (value.schemaVersion !== 1 || value.profile !== NARRATIVE_BEAT_GRAPH_PROFILE || value.profileVersion !== "1.0.0") invalid("narrativeBeatGraph.profile");
  hash(value.draftHash, "narrativeBeatGraph.draftHash");
  hash(value.timingContextHash, "narrativeBeatGraph.timingContextHash");
  integer(value.durationFrames, "narrativeBeatGraph.durationFrames", 30, 10800);
  integer(value.fps, "narrativeBeatGraph.fps", 24, 60);
  const microbeatIds = new Set();
  let previousEnd = 0;
  array(value.sections, "narrativeBeatGraph.sections", 1, 20).forEach((section, index) => {
    const field = `narrativeBeatGraph.sections[${index}]`;
    exact(section, ["id", "role", "beatId", "startFrame", "endFrame", "microbeatIds"], field);
    text(section.id, `${field}.id`, 80, ID_RE);
    text(section.beatId, `${field}.beatId`, 80, ID_RE);
    if (!["hook", "context", "evidence", "turn", "payoff"].includes(section.role)) invalid(`${field}.role`);
    integer(section.startFrame, `${field}.startFrame`, 0, value.durationFrames - 1);
    integer(section.endFrame, `${field}.endFrame`, section.startFrame + 1, value.durationFrames);
    if (section.startFrame !== previousEnd) invalid(`${field}.startFrame`, "non_contiguous");
    previousEnd = section.endFrame;
    array(section.microbeatIds, `${field}.microbeatIds`, 1, 12).forEach((id) => microbeatIds.add(text(id, `${field}.microbeatIds`, 80, ID_RE)));
  });
  if (previousEnd !== value.durationFrames) invalid("narrativeBeatGraph.sections", "duration_not_covered");
  const seen = new Set();
  array(value.microbeats, "narrativeBeatGraph.microbeats", 1, 80).forEach((microbeat, index) => {
    const field = `narrativeBeatGraph.microbeats[${index}]`;
    exact(microbeat, ["id", "sectionId", "type", "sentenceId", "startFrame", "endFrame", "wordStartIndex", "wordEndIndex", "semanticText"], field);
    text(microbeat.id, `${field}.id`, 80, ID_RE);
    if (seen.has(microbeat.id) || !microbeatIds.has(microbeat.id)) invalid(`${field}.id`);
    seen.add(microbeat.id);
    text(microbeat.sectionId, `${field}.sectionId`, 80, ID_RE);
    text(microbeat.sentenceId, `${field}.sentenceId`, 80, ID_RE);
    if (!["setup", "mechanism", "example", "payoff"].includes(microbeat.type)) invalid(`${field}.type`);
    integer(microbeat.startFrame, `${field}.startFrame`, 0, value.durationFrames - 1);
    integer(microbeat.endFrame, `${field}.endFrame`, microbeat.startFrame + 1, value.durationFrames);
    integer(microbeat.wordStartIndex, `${field}.wordStartIndex`, 0, 10000);
    integer(microbeat.wordEndIndex, `${field}.wordEndIndex`, microbeat.wordStartIndex + 1, 10001);
    text(microbeat.semanticText, `${field}.semanticText`, 160);
  });
  if (seen.size !== microbeatIds.size) invalid("narrativeBeatGraph.microbeats", "coverage_mismatch");
  assertContentHash(value, "narrativeBeatGraph");
  return Object.freeze(value);
}

function buildDirectorPlan({ draft, sentencePlan, beatGraph, styleSpec, assetManifest }) {
  const sentences = new Map(sentencePlan.sentences.map((sentence) => [sentence.id, sentence]));
  const sections = beatGraph.sections.map((section, sectionIndex) => {
    const layout = sectionIndex === 0
      ? "overview_grid"
      : sectionIndex === beatGraph.sections.length - 1
        ? "cta_network"
        : EDUCATIONAL_LAYOUTS[1 + ((sectionIndex - 1) % 3)];
    return {
      id: `direction_${section.role}`,
      sectionId: section.id,
      layout,
      persistentEntityIds: ["promise_header", "story_thread"],
      microbeatIds: [...section.microbeatIds],
    };
  });
  const microbeats = beatGraph.microbeats.map((microbeat, index) => {
    const sentence = sentences.get(microbeat.sentenceId);
    if (!sentence) invalid("directorPlan.microbeats", "sentence_missing");
    const recipe = GRAMMAR_RECIPE[sentence.capability.grammarId] || EDUCATIONAL_RECIPES[index % EDUCATIONAL_RECIPES.length];
    return {
      id: `cue_${microbeat.id}`,
      microbeatId: microbeat.id,
      recipe,
      transition: index === 0 ? "draw_reveal" : EDUCATIONAL_TRANSITIONS[index % EDUCATIONAL_TRANSITIONS.length],
      focusEntityId: sentence.focusEntity.id,
      assetId: sentence.capability.assetId,
      accentTone: microbeat.type === "payoff" ? "signal" : "accent",
      typography: {
        sectionTitle: draft.script.beats.find((beat) => `section_${beat.role}` === microbeat.sectionId)?.onScreenText || draft.script.title,
        semanticPhrase: microbeat.semanticText,
        label: sentence.capability.assetId.replace(/_/g, " "),
      },
      audioCue: index === 0 || index === beatGraph.microbeats.length - 1
        ? (index === beatGraph.microbeats.length - 1 ? "sfx_soft_whoosh" : "sfx_soft_tick")
        : null,
    };
  });
  const visualEvents = [];
  for (let index = 0; index < beatGraph.microbeats.length; index += 1) {
    const microbeat = beatGraph.microbeats[index];
    const nextFrame = beatGraph.microbeats[index + 1]?.startFrame
      ?? beatGraph.durationFrames;
    let frame = microbeat.startFrame;
    let phase = 0;
    while (frame < nextFrame) {
      visualEvents.push({
        id: `visual_event_${String(visualEvents.length + 1).padStart(3, "0")}`,
        microbeatId: microbeat.id,
        frame,
        type: phase === 0 ? "state_change" : "focus_shift",
      });
      phase += 1;
      frame += Math.round(styleSpec.pacing.meaningfulChangeMaxSeconds * beatGraph.fps * 0.82);
    }
  }
  return withContentHash({
    schemaVersion: 1,
    profile: DIRECTOR_PLAN_PROFILE,
    profileVersion: "1.0.0",
    bindings: {
      draftHash: draft.contentHash,
      sentencePlanHash: sentencePlan.contentHash,
      beatGraphHash: beatGraph.contentHash,
      styleSpecHash: styleSpec.contentHash,
      assetManifestHash: assetManifest.contentHash,
    },
    promise: {
      title: draft.script.title,
      persistentFromFrame: 0,
      persistentToFrame: beatGraph.durationFrames,
    },
    sections,
    microbeats,
    visualEvents,
  });
}

function validateDirectorPlan(input) {
  const value = structuredClone(object(input, "directorPlan"));
  exact(value, ["schemaVersion", "profile", "profileVersion", "bindings", "promise", "sections", "microbeats", "visualEvents", "contentHash"], "directorPlan");
  if (value.schemaVersion !== 1 || value.profile !== DIRECTOR_PLAN_PROFILE || value.profileVersion !== "1.0.0") invalid("directorPlan.profile");
  exact(value.bindings, ["draftHash", "sentencePlanHash", "beatGraphHash", "styleSpecHash", "assetManifestHash"], "directorPlan.bindings");
  for (const key of Object.keys(value.bindings)) hash(value.bindings[key], `directorPlan.bindings.${key}`);
  exact(value.promise, ["title", "persistentFromFrame", "persistentToFrame"], "directorPlan.promise");
  text(value.promise.title, "directorPlan.promise.title", 160);
  integer(value.promise.persistentFromFrame, "directorPlan.promise.persistentFromFrame", 0, 0);
  integer(value.promise.persistentToFrame, "directorPlan.promise.persistentToFrame", 30, 10800);
  const microbeatIds = new Set();
  array(value.sections, "directorPlan.sections", 1, 20).forEach((section, index) => {
    const field = `directorPlan.sections[${index}]`;
    exact(section, ["id", "sectionId", "layout", "persistentEntityIds", "microbeatIds"], field);
    text(section.id, `${field}.id`, 80, ID_RE);
    text(section.sectionId, `${field}.sectionId`, 80, ID_RE);
    if (!EDUCATIONAL_LAYOUTS.includes(section.layout)) invalid(`${field}.layout`);
    if (JSON.stringify(section.persistentEntityIds) !== JSON.stringify(["promise_header", "story_thread"])) invalid(`${field}.persistentEntityIds`);
    array(section.microbeatIds, `${field}.microbeatIds`, 1, 12).forEach((id) => microbeatIds.add(text(id, `${field}.microbeatIds`, 80, ID_RE)));
  });
  const seen = new Set();
  array(value.microbeats, "directorPlan.microbeats", 1, 80).forEach((cue, index) => {
    const field = `directorPlan.microbeats[${index}]`;
    exact(cue, ["id", "microbeatId", "recipe", "transition", "focusEntityId", "assetId", "accentTone", "typography", "audioCue"], field);
    text(cue.id, `${field}.id`, 80, ID_RE);
    text(cue.microbeatId, `${field}.microbeatId`, 80, ID_RE);
    if (seen.has(cue.microbeatId) || !microbeatIds.has(cue.microbeatId)) invalid(`${field}.microbeatId`);
    seen.add(cue.microbeatId);
    if (!EDUCATIONAL_RECIPES.includes(cue.recipe)) invalid(`${field}.recipe`);
    if (!EDUCATIONAL_TRANSITIONS.includes(cue.transition)) invalid(`${field}.transition`);
    text(cue.focusEntityId, `${field}.focusEntityId`, 80, ID_RE);
    text(cue.assetId, `${field}.assetId`, 80, ID_RE);
    if (!["accent", "signal"].includes(cue.accentTone)) invalid(`${field}.accentTone`);
    exact(cue.typography, ["sectionTitle", "semanticPhrase", "label"], `${field}.typography`);
    text(cue.typography.sectionTitle, `${field}.typography.sectionTitle`, 160);
    text(cue.typography.semanticPhrase, `${field}.typography.semanticPhrase`, 160);
    text(cue.typography.label, `${field}.typography.label`, 80);
    if (cue.audioCue !== null && !["sfx_soft_tick", "sfx_soft_whoosh"].includes(cue.audioCue)) invalid(`${field}.audioCue`);
  });
  if (seen.size !== microbeatIds.size) invalid("directorPlan.microbeats", "coverage_mismatch");
  let previousFrame = -1;
  array(value.visualEvents, "directorPlan.visualEvents", value.microbeats.length, 200).forEach((event, index) => {
    const field = `directorPlan.visualEvents[${index}]`;
    exact(event, ["id", "microbeatId", "frame", "type"], field);
    text(event.id, `${field}.id`, 80, ID_RE);
    if (!microbeatIds.has(event.microbeatId)) invalid(`${field}.microbeatId`);
    integer(event.frame, `${field}.frame`, 0, value.promise.persistentToFrame - 1);
    if (event.frame <= previousFrame) invalid(`${field}.frame`, "not_strictly_increasing");
    previousFrame = event.frame;
    if (!["state_change", "focus_shift"].includes(event.type)) invalid(`${field}.type`);
  });
  assertContentHash(value, "directorPlan");
  return Object.freeze(value);
}

function buildAudioIR({ timingContext, directorPlan, beatGraph, assetManifest }) {
  const cuesByMicrobeat = new Map(directorPlan.microbeats.map((cue) => [cue.microbeatId, cue]));
  const microbeatsById = new Map(
    beatGraph.microbeats.map((microbeat) => [microbeat.id, microbeat]),
  );
  const sfxClips = [];
  for (const section of directorPlan.sections) {
    for (const microbeatId of section.microbeatIds) {
      const cue = cuesByMicrobeat.get(microbeatId);
      if (!cue?.audioCue) continue;
      const microbeat = microbeatsById.get(microbeatId);
      if (!microbeat) invalid("audioIR.tracks.sfx", "microbeat_missing");
      const frame = microbeat.startFrame;
      sfxClips.push({
        id: `audio_${microbeatId}`,
        assetId: cue.audioCue,
        startFrame: frame,
        gainDb: cue.audioCue === "sfx_soft_whoosh" ? -18 : -22,
      });
    }
  }
  return withContentHash({
    schemaVersion: 1,
    profile: AUDIO_IR_PROFILE,
    profileVersion: "1.0.0",
    fps: timingContext.fps,
    durationFrames: timingContext.durationFrames,
    assetManifestHash: assetManifest.contentHash,
    tracks: [
      {
        id: "voice",
        type: "narration",
        enabled: true,
        clips: [{ id: "bound_narration", startFrame: 0, endFrame: timingContext.durationFrames, gainDb: 0 }],
      },
      {
        id: "music",
        type: "music_bed",
        enabled: false,
        clips: [],
      },
      {
        id: "sfx",
        type: "sound_effects",
        enabled: true,
        clips: sfxClips,
      },
    ],
    mix: {
      integratedLufs: -16,
      truePeakDbtp: -1.5,
      narrationDuckingDb: -8,
      attackMs: 20,
      releaseMs: 180,
    },
  });
}

function validateAudioIR(input) {
  const value = structuredClone(object(input, "audioIR"));
  exact(value, ["schemaVersion", "profile", "profileVersion", "fps", "durationFrames", "assetManifestHash", "tracks", "mix", "contentHash"], "audioIR");
  if (value.schemaVersion !== 1 || value.profile !== AUDIO_IR_PROFILE || value.profileVersion !== "1.0.0") invalid("audioIR.profile");
  integer(value.fps, "audioIR.fps", 24, 60);
  integer(value.durationFrames, "audioIR.durationFrames", 30, 10800);
  hash(value.assetManifestHash, "audioIR.assetManifestHash");
  const ids = new Set();
  array(value.tracks, "audioIR.tracks", 3, 3).forEach((track, index) => {
    const field = `audioIR.tracks[${index}]`;
    exact(track, ["id", "type", "enabled", "clips"], field);
    text(track.id, `${field}.id`, 80, ID_RE);
    if (ids.has(track.id)) invalid(`${field}.id`);
    ids.add(track.id);
    if (!["narration", "music_bed", "sound_effects"].includes(track.type) || typeof track.enabled !== "boolean") invalid(field);
    array(track.clips, `${field}.clips`, track.type === "narration" ? 1 : 0, 80).forEach((clip, clipIndex) => {
      const clipField = `${field}.clips[${clipIndex}]`;
      const allowed = track.type === "sound_effects"
        ? ["id", "assetId", "startFrame", "gainDb"]
        : ["id", "startFrame", "endFrame", "gainDb"];
      exact(clip, allowed, clipField);
      text(clip.id, `${clipField}.id`, 80, ID_RE);
      integer(clip.startFrame, `${clipField}.startFrame`, 0, value.durationFrames - 1);
      number(clip.gainDb, `${clipField}.gainDb`, -60, 6);
      if (track.type === "sound_effects") text(clip.assetId, `${clipField}.assetId`, 80, ID_RE);
      else integer(clip.endFrame, `${clipField}.endFrame`, clip.startFrame + 1, value.durationFrames);
    });
  });
  exact(value.mix, ["integratedLufs", "truePeakDbtp", "narrationDuckingDb", "attackMs", "releaseMs"], "audioIR.mix");
  number(value.mix.integratedLufs, "audioIR.mix.integratedLufs", -24, -12);
  number(value.mix.truePeakDbtp, "audioIR.mix.truePeakDbtp", -3, -1);
  number(value.mix.narrationDuckingDb, "audioIR.mix.narrationDuckingDb", -18, 0);
  integer(value.mix.attackMs, "audioIR.mix.attackMs", 1, 500);
  integer(value.mix.releaseMs, "audioIR.mix.releaseMs", 20, 2000);
  assertContentHash(value, "audioIR");
  return Object.freeze(value);
}

function buildEducationalExplainerArtifacts({ draft, timingContext, sentencePlan }) {
  const referenceStyleSpec = validateReferenceStyleSpec(defaultReferenceStyleSpec());
  const assetManifest = validateEducationalAssetManifest(buildEducationalAssetManifest());
  const narrativeBeatGraph = validateNarrativeBeatGraph(buildNarrativeBeatGraph({
    draft,
    timingContext,
    sentencePlan,
  }));
  const directorPlan = validateDirectorPlan(buildDirectorPlan({
    draft,
    sentencePlan,
    beatGraph: narrativeBeatGraph,
    styleSpec: referenceStyleSpec,
    assetManifest,
  }));
  const audioIR = validateAudioIR(buildAudioIR({
    timingContext,
    directorPlan,
    beatGraph: narrativeBeatGraph,
    assetManifest,
  }));
  return Object.freeze({
    referenceStyleSpec,
    assetManifest,
    narrativeBeatGraph,
    directorPlan,
    audioIR,
  });
}

module.exports = {
  ASSET_MANIFEST_PROFILE,
  AUDIO_IR_PROFILE,
  DIRECTOR_PLAN_PROFILE,
  EDUCATIONAL_EXPLAINER_PROFILE_ID,
  EDUCATIONAL_EXPLAINER_PROFILE_TOKEN,
  EDUCATIONAL_EXPLAINER_PROFILE_VERSION,
  EDUCATIONAL_EXPLAINER_RENDERER,
  EDUCATIONAL_EXPLAINER_SCHEMA_VERSION,
  EDUCATIONAL_EXPLAINER_STYLE_VERSION,
  EDUCATIONAL_EXPLAINER_TEMPLATE_ID,
  EDUCATIONAL_EXPLAINER_TEMPLATE_VERSION,
  EDUCATIONAL_LAYOUTS,
  EDUCATIONAL_RECIPES,
  EDUCATIONAL_TRANSITIONS,
  NARRATIVE_BEAT_GRAPH_PROFILE,
  REFERENCE_STYLE_SPEC_ID,
  REFERENCE_STYLE_SPEC_VERSION,
  buildAudioIR,
  buildDirectorPlan,
  buildEducationalAssetManifest,
  buildEducationalExplainerArtifacts,
  buildNarrativeBeatGraph,
  defaultReferenceStyleSpec,
  validateAudioIR,
  validateDirectorPlan,
  validateEducationalAssetManifest,
  validateNarrativeBeatGraph,
  validateReferenceStyleSpec,
};
