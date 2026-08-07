import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";

import {
  compileGeneralizedVisualCompositionPlanV2ToHtml,
} from "../renderer/hyperframes/generalized-visual-composition-v2.mjs";

const require = createRequire(import.meta.url);
const {
  normalizeAnimationTimingContext,
} = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");
const {
  adaptSemanticEventGraphV3ToVisualProgramV2,
} = require("../server/pipelines/narrated-short/animation/semantic-event-graph-v3-visual-v2-adapter.cjs");
const {
  normalizeDraftBundle,
} = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  buildSemanticEventGraph,
} = require("../server/pipelines/narrated-short/animation/semantic-event-graph.cjs");
const {
  calibrationSemanticGraphContentHashV2,
  compileGeneralizedVisualProgramV2,
} = require("../server/pipelines/narrated-short/animation/visual-program-v2-compiler.cjs");
const {
  evaluateVisualProgramV2Repetition,
  evaluateVisualProgramV2SemanticTrace,
} = require("../server/pipelines/narrated-short/animation/visual-program-v2-quality-gates.cjs");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FPS = 30;
const SAMPLE_RATE = 48_000;
const SAMPLES_PER_FRAME = SAMPLE_RATE / FPS;
const FULL_FFMPEG = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const FULL_FFPROBE = "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe";
const FFMPEG = existsSync(FULL_FFMPEG) ? FULL_FFMPEG : "ffmpeg";
const FFPROBE = existsSync(FULL_FFPROBE) ? FULL_FFPROBE : "ffprobe";
const REMOTE_SCHEME_RE = /^(?:https?|wss?):/i;
const PLANNER_MODES = Object.freeze(["operator", "auto", "live"]);

const STORY_CONFIGS = Object.freeze({
  gps: Object.freeze({
    id: "gps",
    title: "WHY A GPS DATE JUMPED BACK",
    sourceSpec: "eval/narrated/dark-curiosity/calibration/gps-week-counter-mechanism-v1.json",
    sourceVideo: "showcase/assets/mechanism-explainer-gps-calibration-v1.mp4",
    sourceVtt: "showcase/assets/mechanism-explainer-gps-calibration-v1.vtt",
    sourceAss: "showcase/evidence/mechanism-explainer-gps-calibration-v1/caption-preview.ass",
    audioManifest: "showcase/evidence/mechanism-explainer-gps-calibration-v1/audio-manifest.json",
    calibrationManifest: "showcase/evidence/mechanism-explainer-gps-calibration-v1/calibration-manifest.json",
  }),
  odometer: Object.freeze({
    id: "odometer",
    title: "WHY AN ODOMETER RETURNS TO ZERO",
    sourceSpec: "eval/narrated/dark-curiosity/calibration/odometer-rollover-mechanism-v1.json",
    sourceVideo: "showcase/assets/mechanism-explainer-odometer-calibration-v1.mp4",
    sourceVtt: "showcase/assets/mechanism-explainer-odometer-calibration-v1.vtt",
    sourceAss: "showcase/evidence/mechanism-explainer-odometer-calibration-v1/caption-preview.ass",
    audioManifest: "showcase/evidence/mechanism-explainer-odometer-calibration-v1/audio-manifest.json",
    calibrationManifest: "showcase/evidence/mechanism-explainer-odometer-calibration-v1/calibration-manifest.json",
  }),
  baychimo: Object.freeze({
    id: "baychimo",
    title: "THE SHIP THE ARCTIC WOULD NOT KEEP",
    sourceKind: "semantic_event_graph_v3",
    sourceSpec: "eval/narrated/dark-curiosity/fixtures/003_baychimo_icebound_drift.json",
    sourceSpecSha256: "c5234f6aca012c71189d7fe57767ab40edd4d86fa7c510dddea097f263bdd8e4",
    semanticManifest: "eval/narrated/dark-curiosity/semantic-events/003_baychimo_icebound_drift.json",
    semanticManifestSha256: "e3875637612ff7a552cb36fa4a8e11b5bbc509e3ce2e1426c608e91be1d8e01d",
    timingContext: "eval/narrated/dark-curiosity/semantic-events/timing/003_baychimo_icebound_drift.timing.json",
    timingContextSha256: "c3deeb6022f40b9cad663034c16528a68710eb51976f8b2002ecc45e3cce0417",
    sourceVideo: "manual-downloads/dark-curiosity-pilots-a940ca6/baychimo-icebound-drift-final.mp4",
    sourceVideoSha256: "b011445f5b69f9ddd022e1b05adcb02362b9d782c4db9c13d88eccccfe775da5",
    sourceVtt: "showcase/assets/dark-curiosity-baychimo-human-v1.vtt",
    sourceAss: "showcase/evidence/dark-curiosity-baychimo-human-v1/caption-preview.ass",
    sourceReport: "manual-downloads/dark-curiosity-pilots-a940ca6/baychimo-icebound-drift-report.json",
    sourceReportSha256: "f960e54ea8cd00e24a4b1d4c82fd979e789c745d5eda6401f82abecadfa32963",
    captionManifest: "showcase/evidence/dark-curiosity-baychimo-human-v1/caption-manifest.json",
    rightsStatus: "internal_rights_confirmed_publish_approval_required",
  }),
});

export const GENERALIZED_VISUAL_V2_PROOF_STORIES = STORY_CONFIGS;
export const GENERALIZED_VISUAL_V2_PROOF_STORY_IDS = Object.freeze(Object.keys(STORY_CONFIGS));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function absolute(path) {
  return resolve(ROOT, path);
}

function relativeToRoot(path) {
  return relative(ROOT, path).replaceAll("\\", "/");
}

function run(binary, args, label, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed: ${result.error?.message || result.stderr || result.stdout}`);
  }
  return result;
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function parseGeneralizedVisualV2ProofArguments(argv = []) {
  let story = "all";
  let confirmWrite = false;
  let dryRun = false;
  let plannerMode = "auto";
  let requireLivePlanner = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--story") {
      story = argv[index + 1];
      index += 1;
    } else if (value === "--planner-mode") {
      plannerMode = argv[index + 1];
      index += 1;
    } else if (value === "--require-live-planner") {
      requireLivePlanner = true;
    } else if (value === "--confirm-write") confirmWrite = true;
    else if (value === "--dry-run") dryRun = true;
    else throw new TypeError(`Unsupported argument: ${value}`);
  }
  if (![...GENERALIZED_VISUAL_V2_PROOF_STORY_IDS, "all"].includes(story)) {
    throw new TypeError("--story must be gps, odometer, baychimo, or all.");
  }
  if (!PLANNER_MODES.includes(plannerMode)) throw new TypeError("--planner-mode must be operator, auto, or live.");
  if (requireLivePlanner && plannerMode === "operator") {
    throw new TypeError("--require-live-planner cannot be combined with --planner-mode operator.");
  }
  if (requireLivePlanner) plannerMode = "live";
  if (dryRun && confirmWrite) throw new TypeError("--dry-run and --confirm-write cannot be combined.");
  const storyIds = story === "all" ? [...GENERALIZED_VISUAL_V2_PROOF_STORY_IDS] : [story];
  return freeze({
    story,
    storyIds,
    confirmWrite,
    dryRun: dryRun || !confirmWrite,
    plannerMode,
    requireLivePlanner,
  });
}

function flattenedWords(audioManifest) {
  const words = Array.isArray(audioManifest.words) && audioManifest.words.length
    ? audioManifest.words
    : audioManifest.phrases.flatMap((phrase) => phrase.words || []);
  return [...words].sort((left, right) => left.globalIndex - right.globalIndex);
}

export function buildGeneralizedVisualV2ProofTimingContext(storyId) {
  const config = STORY_CONFIGS[storyId];
  if (!config) throw new TypeError(`Unknown proof story: ${storyId}`);
  if (config.sourceKind === "semantic_event_graph_v3") {
    if (fileSha256(absolute(config.sourceSpec)) !== config.sourceSpecSha256
      || fileSha256(absolute(config.semanticManifest)) !== config.semanticManifestSha256
      || fileSha256(absolute(config.timingContext)) !== config.timingContextSha256) {
      throw new Error(`${storyId} checked semantic source hash mismatch.`);
    }
    return normalizeAnimationTimingContext(readJson(absolute(config.timingContext)));
  }
  const audioManifest = readJson(absolute(config.audioManifest));
  const sourceSpecBytes = readFileSync(absolute(config.sourceSpec));
  const draftHash = sha256(sourceSpecBytes);
  const words = flattenedWords(audioManifest).map((word, index) => {
    if (word.globalIndex !== index) throw new Error(`${storyId} word timing is not contiguous.`);
    return {
      index,
      text: word.text,
      startFrame: word.startFrame,
      endFrame: word.endFrame,
    };
  });
  const beats = audioManifest.phrases.map((phrase) => {
    const phraseWords = [...phrase.words].sort((left, right) => left.globalIndex - right.globalIndex);
    return {
      beatId: phrase.id,
      wordStartIndex: phraseWords[0].globalIndex,
      wordEndIndex: phraseWords.at(-1).globalIndex + 1,
      startFrame: phraseWords[0].startFrame,
      endFrame: phraseWords.at(-1).endFrame,
    };
  });
  return normalizeAnimationTimingContext({
    schemaVersion: 1,
    fps: FPS,
    durationFrames: audioManifest.durationFrames,
    alignmentHash: audioManifest.audioSha256,
    draftHash,
    words,
    beats,
  });
}

function entity(id, kind, label, persistent, claimIds) {
  return { id, kind, visualSubjectKind: kind, label, persistent, claimIds };
}

function splitBeatSpan(beat, partIndex = 0, partCount = 1) {
  const length = beat.endFrame - beat.startFrame;
  const startFrame = beat.startFrame + Math.floor((length * partIndex) / partCount);
  const rawEnd = beat.startFrame + Math.floor((length * (partIndex + 1)) / partCount);
  return { startFrame, endFrame: Math.max(startFrame + 2, rawEnd) };
}

function proposition(timingContext, spec) {
  const beat = timingContext.beats.find((entry) => entry.beatId === spec.beatId);
  if (!beat) throw new Error(`Unknown proof beat: ${spec.beatId}`);
  return {
    id: spec.id,
    beatId: spec.beatId,
    eventKind: spec.eventKind || "causal_action",
    predicate: spec.predicate,
    polarity: spec.polarity || "affirmed",
    certainty: spec.certainty || "verified",
    subject: { entityId: spec.subject },
    object: { entityIds: spec.objects || [] },
    visualAction: {
      operation: spec.operation || "connect_entities",
      focusEntityIds: spec.focus,
    },
    wordSpan: splitBeatSpan(beat, spec.partIndex || 0, spec.partCount || 1),
  };
}

function gpsGraph(timingContext, draftHash, sourceStoryboardHash) {
  const entities = [
    entity("gps_satellite", "satellite", "GPS SATELLITE", true, ["claim_gps_signal"]),
    entity("gps_week_value", "numeric_token", "10-BIT WEEK VALUE", true, ["claim_gps_signal", "claim_gps_bits"]),
    entity("gps_receiver", "receiver", "GPS RECEIVER", true, ["claim_gps_bits", "claim_gps_mapping"]),
    entity("gps_maximum", "numeric_token", "1,023", false, ["claim_gps_limit"]),
    entity("gps_zero", "numeric_token", "0000", true, ["claim_gps_rollover"]),
    entity("gps_wrong_date", "calendar", "1999 — WRONG", false, ["claim_gps_wrong_date"]),
    entity("gps_real_time", "clock", "REAL TIME →", true, ["claim_gps_real_time"]),
    entity("gps_correct_date", "calendar", "2019 — CORRECT", true, ["claim_gps_correct_date"]),
    entity("gps_patch", "document", "SOFTWARE UPDATE", false, ["claim_gps_patch"]),
  ];
  const specs = [
    { id: "prop_gps_signal_value", beatId: "gps_week_not_date", subject: "gps_satellite", objects: ["gps_week_value"], predicate: "transmits_week_value", focus: ["gps_week_value"] },
    { id: "prop_gps_store_bits", beatId: "gps_ten_bits", subject: "gps_week_value", objects: ["gps_receiver"], predicate: "encoded_by_ten_bits", focus: ["gps_receiver"] },
    { id: "prop_gps_limit", beatId: "gps_value_range", subject: "gps_week_value", objects: ["gps_maximum"], predicate: "reaches_limit", focus: ["gps_maximum"] },
    { id: "prop_gps_no_next", beatId: "gps_at_limit", subject: "gps_maximum", objects: ["gps_week_value"], predicate: "has_next_value", polarity: "negated", focus: ["gps_maximum"] },
    { id: "prop_gps_rollover", beatId: "gps_rollover", subject: "gps_maximum", objects: ["gps_zero"], predicate: "rolls_over_to", eventKind: "state_transition", operation: "replace_value", focus: ["gps_zero"] },
    { id: "prop_gps_old_mapping", beatId: "gps_old_cycle", subject: "gps_receiver", objects: ["gps_wrong_date"], predicate: "maps_zero_to_previous_cycle", focus: ["gps_wrong_date"] },
    { id: "prop_gps_backward", beatId: "gps_date_backward", subject: "gps_wrong_date", objects: ["gps_real_time"], predicate: "contrasts_with_real_time", focus: ["gps_wrong_date"] },
    { id: "prop_gps_time_continues", beatId: "gps_time_continues", subject: "gps_real_time", objects: ["gps_correct_date"], predicate: "continues_forward_to", focus: ["gps_real_time"] },
    { id: "prop_gps_patch", beatId: "gps_patch", subject: "gps_patch", objects: ["gps_receiver"], predicate: "corrects_mapping", focus: ["gps_receiver"] },
    { id: "prop_gps_correct_mapping", beatId: "gps_correct_date", subject: "gps_receiver", objects: ["gps_correct_date"], predicate: "maps_to_correct_cycle", focus: ["gps_correct_date"] },
    { id: "prop_gps_payoff", beatId: "gps_payoff", subject: "gps_zero", objects: ["gps_real_time"], predicate: "repeats_while_time_continues", focus: ["gps_real_time"] },
  ];
  return {
    storyTitle: STORY_CONFIGS.gps.title,
    draftHash,
    sourceStoryboardHash,
    timingContextHash: timingContext.contentHash,
    entities,
    propositions: specs.map((spec) => proposition(timingContext, spec)),
  };
}

function odometerGraph(timingContext, draftHash, sourceStoryboardHash) {
  const entities = [
    entity("odometer_vehicle", "vehicle", "SAME CAR", true, ["claim_odometer_machine", "claim_odometer_continues"]),
    entity("odometer_wheel_bank", "wheel_bank", "SIX NUMBER WHEELS", true, ["claim_odometer_wheels", "claim_odometer_carry"]),
    entity("odometer_before_carry", "numeric_token", "000009", false, ["claim_odometer_carry"]),
    entity("odometer_after_carry", "numeric_token", "000010", false, ["claim_odometer_carry"]),
    entity("odometer_maximum", "numeric_token", "999999", false, ["claim_odometer_maximum"]),
    entity("odometer_zero", "numeric_token", "000000", true, ["claim_odometer_zero"]),
  ];
  const specs = [
    { id: "prop_odometer_wheels", beatId: "odometer_six_wheels", subject: "odometer_vehicle", objects: ["odometer_wheel_bank"], predicate: "contains_six_wheels", focus: ["odometer_wheel_bank"] },
    { id: "prop_odometer_carry", beatId: "odometer_carry", subject: "odometer_before_carry", objects: ["odometer_wheel_bank"], predicate: "carries_to_next_wheel", operation: "propagate_carry", focus: ["odometer_wheel_bank", "odometer_after_carry"] },
    { id: "prop_odometer_maximum", beatId: "odometer_last_value", subject: "odometer_wheel_bank", objects: ["odometer_maximum"], predicate: "sets_all_wheels_to_nine", focus: ["odometer_maximum"] },
    { id: "prop_odometer_full_carry", beatId: "odometer_one_more", subject: "odometer_maximum", objects: ["odometer_wheel_bank"], predicate: "carries_through_all_wheels", operation: "propagate_carry", focus: ["odometer_wheel_bank"], partIndex: 0, partCount: 2 },
    { id: "prop_odometer_rollover", beatId: "odometer_one_more", subject: "odometer_wheel_bank", objects: ["odometer_zero"], predicate: "rolls_over_to", eventKind: "state_transition", operation: "replace_value", focus: ["odometer_zero"], partIndex: 1, partCount: 2 },
    { id: "prop_odometer_zero", beatId: "odometer_zero", subject: "odometer_zero", objects: ["odometer_wheel_bank"], predicate: "displayed_by_wheel_bank", focus: ["odometer_zero", "odometer_wheel_bank"] },
    { id: "prop_odometer_continues", beatId: "odometer_same_car", subject: "odometer_vehicle", objects: [], predicate: "continues_while_display_is_zero", eventKind: "state_transition", operation: "continue_vehicle", focus: ["odometer_vehicle"] },
    { id: "prop_odometer_payoff", beatId: "odometer_payoff", subject: "odometer_wheel_bank", objects: ["odometer_vehicle"], predicate: "finite_display_resets_not_vehicle", eventKind: "state_transition", operation: "contrast_reset", focus: ["odometer_wheel_bank"] },
  ];
  return {
    storyTitle: STORY_CONFIGS.odometer.title,
    draftHash,
    sourceStoryboardHash,
    timingContextHash: timingContext.contentHash,
    entities,
    propositions: specs.map((spec) => proposition(timingContext, spec)),
  };
}

export function buildGeneralizedVisualV2ProofSemanticSource(storyId, timingContext) {
  const config = STORY_CONFIGS[storyId];
  if (!config) throw new TypeError(`Unknown proof story: ${storyId}`);
  if (config.sourceKind === "semantic_event_graph_v3") {
    const draft = normalizeDraftBundle(readJson(absolute(config.sourceSpec)));
    const manifest = readJson(absolute(config.semanticManifest));
    const sourceGraph = buildSemanticEventGraph({ draft, timingContext, manifest });
    const adapted = adaptSemanticEventGraphV3ToVisualProgramV2({
      draft,
      timingContext,
      sourceGraph,
    });
    if (adapted.graph.storyTitle !== config.title) {
      throw new Error(`${storyId} trusted title binding mismatch.`);
    }
    return freeze({
      graph: adapted.graph,
      provenance: adapted.provenance,
    });
  }
  const draftHash = fileSha256(absolute(config.sourceSpec));
  const sourceStoryboardHash = sha256(`${draftHash}:generalized_visual_v2_operator_storyboard:${storyId}`);
  const graph = storyId === "gps"
    ? gpsGraph(timingContext, draftHash, sourceStoryboardHash)
    : odometerGraph(timingContext, draftHash, sourceStoryboardHash);
  return freeze({
    graph,
    provenance: {
      profile: "operator_calibration_graph_v1",
      version: "1.0.0",
      sourceProfile: "mechanism_explainer_calibration_v1",
      sourceGraphHash: calibrationSemanticGraphContentHashV2(graph),
      approvedDraftHash: draftHash,
      timingContextHash: timingContext.contentHash,
      entityCount: graph.entities.length,
      propositionCount: graph.propositions.length,
      sourceGraphAuthoringMode: "operator_calibration_fixture",
      v2GraphHandAuthored: true,
    },
  });
}

export function buildGeneralizedVisualV2ProofSemanticGraph(storyId, timingContext) {
  return buildGeneralizedVisualV2ProofSemanticSource(storyId, timingContext).graph;
}

const SCENE_BLUEPRINTS = Object.freeze({
  gps: Object.freeze([
    ["gps_signal_path", ["prop_gps_signal_value", "prop_gps_store_bits"], "directed_flow", "gps_week_value"],
    ["gps_finite_rollover", ["prop_gps_limit", "prop_gps_no_next", "prop_gps_rollover"], "cycle_orbit", "gps_zero"],
    ["gps_wrong_vs_real", ["prop_gps_old_mapping", "prop_gps_backward", "prop_gps_time_continues"], "split_compare", "gps_wrong_date"],
    ["gps_corrected_mapping", ["prop_gps_patch", "prop_gps_correct_mapping"], "directed_flow", "gps_correct_date"],
    ["gps_number_vs_time", ["prop_gps_payoff"], "split_compare", "gps_real_time"],
  ]),
  odometer: Object.freeze([
    ["odometer_machine", ["prop_odometer_wheels"], "layered_stack", "odometer_wheel_bank"],
    ["odometer_carry_chain", ["prop_odometer_carry"], "directed_flow", "odometer_wheel_bank"],
    ["odometer_maximum_state", ["prop_odometer_maximum"], "radial_focus", "odometer_maximum"],
    ["odometer_full_rollover", ["prop_odometer_full_carry", "prop_odometer_rollover"], "radial_focus", "odometer_zero"],
    ["odometer_display_vs_car", ["prop_odometer_zero", "prop_odometer_continues", "prop_odometer_payoff"], "split_compare", "odometer_vehicle"],
  ]),
  baychimo: Object.freeze([
    ["baychimo_blizzard_absence", ["baychimo_hook_year", "baychimo_hook_crew_observation", "baychimo_hook_observed_absence"], "layered_stack", "baychimo"],
    ["baychimo_assumption_sighting", ["baychimo_context_sinking_assumption", "baychimo_context_hunter_sighting"], "layered_stack", "baychimo"],
    ["baychimo_witnessed_again", ["baychimo_evidence_later_years", "baychimo_evidence_sightings"], "directed_flow", "baychimo"],
    ["baychimo_boarding_drift", ["baychimo_evidence_boardings", "baychimo_evidence_without_crew", "baychimo_evidence_pack_ice_drift"], "directed_flow", "baychimo"],
    ["baychimo_archive_span", ["baychimo_turn_latest_record", "baychimo_turn_decades_after_abandonment"], "directed_flow", "company_archive_record"],
    ["baychimo_evidence_boundary", ["baychimo_payoff_documented_drift", "baychimo_payoff_not_supernatural", "baychimo_payoff_unknown_fate"], "split_compare", "baychimo_final_fate"],
  ]),
});

function orderedParticipants(propositions) {
  const result = [];
  const seen = new Set();
  for (const entry of propositions) {
    for (const id of [entry.subject.entityId, ...entry.object.entityIds, ...entry.visualAction.focusEntityIds]) {
      if (!seen.has(id)) { seen.add(id); result.push(id); }
    }
  }
  return result;
}

export function buildGeneralizedVisualV2ProofProposal(storyId, semanticEventGraph, timingContext) {
  const propositionById = new Map(semanticEventGraph.propositions.map((entry) => [entry.id, entry]));
  const scenes = SCENE_BLUEPRINTS[storyId].map(([id, propositionIds, layoutIntent, focusEntityId]) => {
    const propositions = propositionIds.map((entry) => propositionById.get(entry));
    if (propositions.some((entry) => !entry)) throw new Error(`${storyId} proof blueprint is stale.`);
    return {
      id,
      entityIds: orderedParticipants(propositions),
      propositionIds,
      layoutIntent,
      focusEntityId,
    };
  });
  return {
    schemaVersion: 2,
    profile: "generalized_visual_program_proposal_v2",
    bindings: {
      semanticEventGraphHash: calibrationSemanticGraphContentHashV2(semanticEventGraph),
      timingContextHash: timingContext.contentHash,
      draftHash: semanticEventGraph.draftHash,
      sourceRevisionHash: semanticEventGraph.sourceStoryboardHash,
    },
    styleSpecId: "educational_line_art_reference_v1",
    scenes,
  };
}

export function compileGeneralizedVisualV2ProofStory(storyId) {
  const config = STORY_CONFIGS[storyId];
  if (!config) throw new TypeError(`Unknown proof story: ${storyId}`);
  const timingContext = buildGeneralizedVisualV2ProofTimingContext(storyId);
  const semanticSource = buildGeneralizedVisualV2ProofSemanticSource(storyId, timingContext);
  const semanticEventGraph = semanticSource.graph;
  const proposal = buildGeneralizedVisualV2ProofProposal(storyId, semanticEventGraph, timingContext);
  const plan = compileGeneralizedVisualProgramV2({
    proposal,
    semanticEventGraph,
    timingContext,
    trustMode: "calibration_trusted",
  });
  const semanticGate = evaluateVisualProgramV2SemanticTrace(plan);
  if (!semanticGate.passed) throw new Error(`${storyId} semantic trace gate failed.`);
  const composition = compileGeneralizedVisualCompositionPlanV2ToHtml(plan);
  return freeze({
    config,
    timingContext,
    semanticEventGraph,
    sourceProvenance: semanticSource.provenance,
    proposal,
    plan,
    semanticGate,
    composition,
    plannerProvenance: {
      plannerId: "operator_bounded_blueprint_v2",
      mode: "operator",
      providerId: "engine_operator_fixture",
      modelId: null,
      promptProfileId: null,
      plannerConfigurationHash: sha256(`operator:${storyId}:generalized_visual_program_proposal_v2`),
      attemptCount: 0,
      fallbackUsed: false,
      failure: null,
    },
  });
}

function loadVisualProgramV2PlannerService() {
  try {
    const {
      createLocalLlmVisualProgramV2Planner,
    } = require("../server/pipelines/narrated-short/animation/providers/local-llm-visual-program-v2-planner.cjs");
    const {
      planGeneralizedVisualProgramV2,
    } = require("../server/pipelines/narrated-short/animation/visual-program-v2-planner-service.cjs");
    if (typeof createLocalLlmVisualProgramV2Planner !== "function"
      || typeof planGeneralizedVisualProgramV2 !== "function") {
      throw new TypeError("The visual-program v2 planner service exports are incomplete.");
    }
    return { createLocalLlmVisualProgramV2Planner, planGeneralizedVisualProgramV2 };
  } catch (error) {
    if (error?.code === "MODULE_NOT_FOUND") {
      throw new Error("The visual-program v2 planner service is unavailable.", { cause: error });
    }
    throw error;
  }
}

export async function planGeneralizedVisualV2ProofStory(storyId, options = {}) {
  const plannerMode = options.plannerMode || "operator";
  if (!PLANNER_MODES.includes(plannerMode)) throw new TypeError("Unsupported proof planner mode.");
  if (options.requireLivePlanner === true && plannerMode === "operator") {
    throw new TypeError("A live planner cannot be required in operator mode.");
  }
  if (plannerMode === "operator") return compileGeneralizedVisualV2ProofStory(storyId);
  const config = STORY_CONFIGS[storyId];
  if (!config) throw new TypeError(`Unknown proof story: ${storyId}`);
  const timingContext = buildGeneralizedVisualV2ProofTimingContext(storyId);
  const semanticSource = buildGeneralizedVisualV2ProofSemanticSource(storyId, timingContext);
  const service = loadVisualProgramV2PlannerService();
  const planner = options.planner || service.createLocalLlmVisualProgramV2Planner({
    mode: plannerMode === "live" ? "openai_compatible" : undefined,
    env: options.env || process.env,
  });
  const result = await service.planGeneralizedVisualProgramV2({
    storyId,
    semanticEventGraph: semanticSource.graph,
    timingContext,
    baselinePrograms: options.baselinePrograms || [],
    planner,
    signal: options.signal || null,
  });
  if (!result?.choice || !Object.isFrozen(result.choice)
    || !result?.proposal || !result?.visualProgram || !result?.provenance
    || result.semanticGate?.passed !== true) {
    throw new Error(`${storyId} planner service did not return an accepted visual program.`);
  }
  if (result.choice.contentHash !== result.provenance.choiceHash) {
    throw new Error(`${storyId} planner choice hash does not match its provenance.`);
  }
  const liveRequired = plannerMode === "live" || options.requireLivePlanner === true;
  const liveSatisfied = result.provenance.providerId === "local_openai_compatible"
    && result.provenance.fallbackUsed === false;
  if (liveRequired && !liveSatisfied) {
    throw new Error(`${storyId} did not produce a live local-LLM planner result.`);
  }
  if (result.visualProgram.presentation.title !== config.title) {
    throw new Error(`${storyId} planner changed the engine-owned trusted title.`);
  }
  const composition = compileGeneralizedVisualCompositionPlanV2ToHtml(result.visualProgram);
  return freeze({
    config,
    timingContext,
    semanticEventGraph: semanticSource.graph,
    sourceProvenance: semanticSource.provenance,
    plannerChoice: result.choice,
    proposal: result.proposal,
    plan: result.visualProgram,
    semanticGate: result.semanticGate,
    repetitionGate: result.repetitionGate || null,
    composition,
    plannerProvenance: result.provenance,
  });
}

export function verifyGeneralizedVisualV2ProofSourceArtifacts(bundle) {
  const sourceVideo = absolute(bundle.config.sourceVideo);
  const actualVideoHash = fileSha256(sourceVideo);
  if (bundle.config.sourceKind === "semantic_event_graph_v3") {
    const sourceReportPath = absolute(bundle.config.sourceReport);
    if (fileSha256(sourceReportPath) !== bundle.config.sourceReportSha256
      || actualVideoHash !== bundle.config.sourceVideoSha256) {
      throw new Error(`${bundle.config.id} rights-bound source hash mismatch.`);
    }
    const sourceReport = readJson(sourceReportPath);
    if (sourceReport.status !== "complete"
      || sourceReport.readiness?.rightsConfirmed !== true
      || sourceReport.readiness?.narrationAvailable !== true
      || sourceReport.final?.status !== "completed"
      || sourceReport.final?.outputHash !== actualVideoHash
      || sourceReport.approvedDraft?.hash !== bundle.timingContext.draftHash
      || sourceReport.narrationAlignment?.hash !== bundle.timingContext.alignmentHash) {
      throw new Error(`${bundle.config.id} rights/alignment source report is stale.`);
    }
    const captionManifest = readJson(absolute(bundle.config.captionManifest));
    if (captionManifest.draftHash !== bundle.timingContext.draftHash
      || captionManifest.alignmentHash !== bundle.timingContext.alignmentHash
      || captionManifest.durationFrames !== bundle.timingContext.durationFrames) {
      throw new Error(`${bundle.config.id} caption binding is stale.`);
    }
    if (!existsSync(absolute(bundle.config.sourceAss)) || !existsSync(absolute(bundle.config.sourceVtt))) {
      throw new Error(`${bundle.config.id} caption source is missing.`);
    }
    return {
      sourceVideoHash: actualVideoHash,
      sourceReportHash: bundle.config.sourceReportSha256,
      sourceAssHash: fileSha256(absolute(bundle.config.sourceAss)),
      sourceVttHash: fileSha256(absolute(bundle.config.sourceVtt)),
      sourceSemanticGraphHash: bundle.sourceProvenance?.sourceGraphHash || null,
      approvedDraftHash: bundle.timingContext.draftHash,
      alignmentHash: bundle.timingContext.alignmentHash,
      rightsConfirmed: true,
      publishApprovalRequired: true,
    };
  }
  const calibration = readJson(absolute(bundle.config.calibrationManifest));
  if (actualVideoHash !== calibration.artifacts.video.sha256) {
    throw new Error(`${bundle.config.id} source calibration video hash mismatch.`);
  }
  if (!existsSync(absolute(bundle.config.sourceAss)) || !existsSync(absolute(bundle.config.sourceVtt))) {
    throw new Error(`${bundle.config.id} caption source is missing.`);
  }
  return {
    sourceVideoHash: actualVideoHash,
    sourceAssHash: fileSha256(absolute(bundle.config.sourceAss)),
    sourceVttHash: fileSha256(absolute(bundle.config.sourceVtt)),
  };
}

function selectedFrames(plan) {
  const frames = [0];
  for (let frame = 0; frame < plan.duration.totalFrames; frame += 60) frames.push(frame);
  for (const scene of plan.scenes) {
    frames.push(Math.max(scene.startFrame, scene.readabilityHold.startFrame));
  }
  frames.push(plan.duration.totalFrames - 1);
  return [...new Set(frames)].sort((left, right) => left - right);
}

async function renderPngSequence(bundle, frameDirectory) {
  const htmlPath = join(frameDirectory, "composition.html");
  writeFileSync(htmlPath, bundle.composition.html, "utf8");
  const remoteRequests = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1080, height: 1920 },
      deviceScaleFactor: 1,
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.on("request", (request) => {
      if (REMOTE_SCHEME_RE.test(request.url())) remoteRequests.push(request.url());
    });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const metadata = await page.evaluate(() => ({
      width: document.querySelector("main")?.dataset.width,
      height: document.querySelector("main")?.dataset.height,
      hasRenderFrame: typeof window.__renderFrame === "function",
      sceneCount: document.querySelectorAll("[data-visual-scene]").length,
      title: document.querySelector(".promise-copy")?.textContent,
    }));
    if (metadata.width !== "1080" || metadata.height !== "1920" || !metadata.hasRenderFrame
      || metadata.sceneCount !== bundle.plan.scenes.length || metadata.title !== bundle.config.title) {
      throw new Error(`${bundle.config.id} browser metadata proof failed.`);
    }
    const sampleSet = new Set(selectedFrames(bundle.plan));
    const sampleHashes = {};
    for (let frame = 0; frame < bundle.plan.duration.totalFrames; frame += 1) {
      await page.evaluate(async (value) => {
        window.__renderFrame(value);
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      }, frame);
      const path = join(frameDirectory, `frame-${String(frame).padStart(6, "0")}.png`);
      await page.screenshot({ path, animations: "disabled" });
      if (sampleSet.has(frame)) sampleHashes[String(frame)] = fileSha256(path);
      if (frame === 0 || (frame + 1) % 120 === 0 || frame === bundle.plan.duration.totalFrames - 1) {
        process.stdout.write(`[${bundle.config.id}] frames ${frame + 1}/${bundle.plan.duration.totalFrames}\n`);
      }
    }
    await context.close();
    if (remoteRequests.length) throw new Error(`${bundle.config.id} attempted a remote request.`);
    return { metadata, sampleHashes };
  } finally {
    await browser.close();
  }
}

function ffmpegFilterPath(path) {
  return path.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "'\\''");
}

function renderVideo(bundle, frameDirectory, outputPath) {
  const totalFrames = bundle.plan.duration.totalFrames;
  const duration = (totalFrames / FPS).toFixed(6);
  const totalSamples = totalFrames * SAMPLES_PER_FRAME;
  const assPath = absolute(bundle.config.sourceAss);
  run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-framerate", String(FPS), "-start_number", "0",
    "-i", join(frameDirectory, "frame-%06d.png"),
    "-i", absolute(bundle.config.sourceVideo),
    "-i", join(frameDirectory, "frame-000000.png"),
    "-filter_complex", `[0:v]subtitles=filename='${ffmpegFilterPath(assPath)}'[captioned];[2:v]crop=1080:190:0:0[title_band];[captioned][title_band]overlay=0:0:eof_action=repeat:repeatlast=1:shortest=0[video]`,
    "-map", "[video]", "-map", "1:a:0",
    "-af", `aresample=${SAMPLE_RATE},apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples},asetpts=N/SR/TB`,
    "-frames:v", String(totalFrames), "-r", String(FPS), "-fps_mode", "cfr",
    "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", String(SAMPLE_RATE), "-ac", "1",
    "-t", duration, "-movflags", "+faststart", outputPath,
  ], `${bundle.config.id} proof video`);
}

function normalizedOcr(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function verifyPersistentTitleOcr(bundle, videoPath, staging) {
  const expected = normalizedOcr(bundle.config.title);
  const results = [];
  for (const frame of selectedFrames(bundle.plan)) {
    const crop = join(staging, `title-ocr-${String(frame).padStart(6, "0")}.png`);
    run(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y", "-i", videoPath,
      "-vf", `select=eq(n\\,${frame}),crop=1080:190:0:0`,
      "-frames:v", "1", crop,
    ], `${bundle.config.id} title OCR frame ${frame}`);
    const detected = run("tesseract", [crop, "stdout", "--psm", "7"], `${bundle.config.id} title OCR`).stdout.trim();
    const passed = normalizedOcr(detected).includes(expected);
    results.push({ frame, detected, passed, cropSha256: fileSha256(crop) });
    if (!passed) throw new Error(`${bundle.config.id} persistent title OCR failed at frame ${frame}: ${detected}`);
  }
  return results;
}

function probeVideo(path) {
  const raw = run(FFPROBE, [
    "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", path,
  ], `ffprobe ${basename(path)}`).stdout;
  const parsed = JSON.parse(raw);
  const video = parsed.streams.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams.find((stream) => stream.codec_type === "audio");
  if (!video || !audio) throw new Error("Proof output is missing video or audio.");
  return {
    width: Number(video.width),
    height: Number(video.height),
    frameRate: video.avg_frame_rate,
    frameCount: Number(video.nb_read_frames || video.nb_frames),
    videoCodec: video.codec_name,
    pixelFormat: video.pix_fmt,
    audioCodec: audio.codec_name,
    audioSampleRate: Number(audio.sample_rate),
    audioChannels: Number(audio.channels),
    durationSeconds: Number(parsed.format.duration),
  };
}

function assertProbe(bundle, probe) {
  if (probe.width !== 1080 || probe.height !== 1920 || probe.frameRate !== "30/1"
    || probe.frameCount !== bundle.plan.duration.totalFrames || probe.videoCodec !== "h264"
    || probe.audioCodec !== "aac" || probe.audioSampleRate !== SAMPLE_RATE) {
    throw new Error(`${bundle.config.id} technical media gate failed: ${JSON.stringify(probe)}`);
  }
}

function renderContactSheet(bundle, videoPath, contactPath) {
  const wanted = Array.from({ length: 8 }, (_, index) => Math.min(
    bundle.plan.duration.totalFrames - 1,
    Math.round((bundle.plan.duration.totalFrames - 1) * index / 7),
  ));
  const expression = wanted.map((frame) => `eq(n\\,${frame})`).join("+");
  run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", videoPath,
    "-vf", `select=${expression},scale=270:480:force_original_aspect_ratio=decrease,pad=270:480:(ow-iw)/2:(oh-ih)/2:black,tile=4x2`,
    "-fps_mode", "vfr", "-frames:v", "1", contactPath,
  ], `${bundle.config.id} contact sheet`);
  return wanted;
}

export function buildGeneralizedVisualV2ProofReport(bundle, values = {}) {
  return freeze({
    schemaVersion: 1,
    proofProfile: "generalized_visual_composition_v2_video_proof",
    storyId: bundle.config.id,
    generatedAt: values.generatedAt || new Date().toISOString(),
    publishable: false,
    humanReviewStatus: "pending",
    humanApproved: false,
    productionReady: false,
    trust: bundle.plan.trust,
    rights: {
      status: bundle.config.rightsStatus || "calibration_only_not_commercially_attested",
      source: relativeToRoot(absolute(bundle.config.sourceVideo)),
      publishApprovalRequired: true,
    },
    planner: bundle.plannerProvenance,
    semanticSource: bundle.sourceProvenance,
    bindings: bundle.plan.bindings,
    style: {
      specId: bundle.plan.style.specId,
      specVersion: bundle.plan.style.specVersion,
      contentHash: bundle.composition.style.contentHash,
    },
    renderer: bundle.composition.renderer,
    duration: bundle.plan.duration,
    proposal: {
      profile: bundle.proposal.profile,
      containsEngineOwnedGeometry: false,
      containsVisibleCopy: false,
      sceneCount: bundle.proposal.scenes.length,
    },
    fingerprints: {
      program: bundle.plan.contentHash,
      composition: bundle.composition.compositionHash,
      scenes: bundle.plan.scenes.map((scene) => ({ id: scene.id, fingerprint: scene.compositionFingerprint })),
      sampledFrames: values.sampleHashes || {},
    },
    semanticTrace: bundle.plan.scenes.map((scene) => ({
      sceneId: scene.id,
      entityIds: scene.entityIds,
      predicates: scene.relations.map((relation) => relation.predicate),
      operations: scene.tracks.map((track) => `${track.operation}:${track.targetKind}`),
    })),
    qualityReports: {
      semanticTrace: bundle.semanticGate,
      persistentTitleOcr: values.titleOcr || [],
    },
    media: values.media || null,
    sources: values.sources || null,
    contactFrames: values.contactFrames || [],
    gates: {
      technical: values.media ? "passed" : "not_run",
      deterministicPlan: "passed",
      noRemoteAssets: values.remoteFree === true ? "passed" : "not_run",
      persistentTitleOcr: values.titleOcr?.every((entry) => entry.passed) ? "passed" : "not_run",
      semanticComposition: bundle.semanticGate.passed ? "passed" : "failed",
      humanPerceptual: "pending",
    },
  });
}

export function validateGeneralizedVisualV2PlannerChoiceArtifact(bundle) {
  const choice = bundle?.plannerChoice;
  const expectedHash = bundle?.plannerProvenance?.choiceHash;
  if (!choice || !Object.isFrozen(choice)
    || !/^[a-f0-9]{64}$/.test(choice.contentHash || "")
    || choice.contentHash !== expectedHash) {
    throw new Error(`${bundle?.config?.id || "unknown"} planner choice evidence is not hash-bound.`);
  }
  return choice;
}

function outputPaths(storyId) {
  const stem = `generalized-visual-v2-${storyId}-proof`;
  const assetDirectory = absolute("showcase/assets");
  const evidenceDirectory = absolute(`showcase/evidence/${stem}`);
  return {
    stem,
    assetDirectory,
    evidenceDirectory,
    video: join(assetDirectory, `${stem}.mp4`),
    vtt: join(assetDirectory, `${stem}.vtt`),
    contact: join(assetDirectory, `${stem}-contact-sheet.png`),
  };
}

async function renderStory(bundle) {
  const paths = outputPaths(bundle.config.id);
  mkdirSync(paths.assetDirectory, { recursive: true });
  mkdirSync(paths.evidenceDirectory, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), `shortsengine-${paths.stem}-`));
  try {
    const sources = verifyGeneralizedVisualV2ProofSourceArtifacts(bundle);
    const browserEvidence = await renderPngSequence(bundle, staging);
    const stagedVideo = join(staging, `${paths.stem}.mp4`);
    const stagedContact = join(staging, `${paths.stem}-contact-sheet.png`);
    renderVideo(bundle, staging, stagedVideo);
    const media = probeVideo(stagedVideo);
    assertProbe(bundle, media);
    const titleOcr = verifyPersistentTitleOcr(bundle, stagedVideo, staging);
    const contactFrames = renderContactSheet(bundle, stagedVideo, stagedContact);
    copyFileSync(stagedVideo, paths.video);
    copyFileSync(absolute(bundle.config.sourceVtt), paths.vtt);
    copyFileSync(stagedContact, paths.contact);
    copyFileSync(stagedContact, join(paths.evidenceDirectory, "contact-sheet.png"));
    writeJson(join(paths.evidenceDirectory, "timing-context.json"), bundle.timingContext);
    writeJson(join(paths.evidenceDirectory, "semantic-event-graph.json"), bundle.semanticEventGraph);
    writeJson(join(paths.evidenceDirectory, "composition-proposal.json"), bundle.proposal);
    if (bundle.plannerChoice) {
      writeJson(
        join(paths.evidenceDirectory, "planner-choice.json"),
        validateGeneralizedVisualV2PlannerChoiceArtifact(bundle),
      );
    }
    writeJson(join(paths.evidenceDirectory, "composition-plan.json"), bundle.plan);
    const report = buildGeneralizedVisualV2ProofReport(bundle, {
      sources,
      sampleHashes: browserEvidence.sampleHashes,
      media: { ...media, sha256: fileSha256(paths.video), bytes: readFileSync(paths.video).byteLength },
      titleOcr,
      contactFrames,
      remoteFree: true,
    });
    writeJson(join(paths.evidenceDirectory, "report.json"), report);
    return freeze({
      storyId: bundle.config.id,
      report,
      paths: Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, key === "stem" ? value : relativeToRoot(value)])),
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function buildGeneralizedVisualV2ComparisonReport(results, repetition) {
  if (!Array.isArray(results) || results.length < 2) {
    throw new TypeError("At least two story results are required for a comparison report.");
  }
  if (!repetition || repetition.passed !== true) {
    throw new TypeError("A passing arbitrary-N repetition report is required.");
  }
  const storyIds = results.map((result) => result.storyId);
  if (new Set(storyIds).size !== storyIds.length) {
    throw new TypeError("Comparison story ids must be unique.");
  }
  const styles = new Set(results.map((result) => result.report.style.contentHash));
  const programHashes = new Set(results.map((result) => result.report.fingerprints.program));
  const sceneFingerprints = results.map((result) => ({
    storyId: result.storyId,
    fingerprints: new Set(result.report.fingerprints.scenes.map((scene) => scene.fingerprint)),
  }));
  const pairwiseComparisons = [];
  for (let leftIndex = 0; leftIndex < sceneFingerprints.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sceneFingerprints.length; rightIndex += 1) {
      const left = sceneFingerprints[leftIndex];
      const right = sceneFingerprints[rightIndex];
      pairwiseComparisons.push({
        leftStoryId: left.storyId,
        rightStoryId: right.storyId,
        sceneFingerprintOverlap: [...left.fingerprints]
          .filter((entry) => right.fingerprints.has(entry))
          .sort(),
      });
    }
  }
  const crossStoryOverlap = pairwiseComparisons.flatMap((comparison) => (
    comparison.sceneFingerprintOverlap.map((fingerprint) => ({
      leftStoryId: comparison.leftStoryId,
      rightStoryId: comparison.rightStoryId,
      fingerprint,
    }))
  ));
  return {
    schemaVersion: 2,
    proofProfile: "generalized_visual_composition_v2_cross_story_comparison",
    publishable: false,
    humanReviewStatus: "pending",
    humanApproved: false,
    productionReady: false,
    stories: storyIds,
    sameStyleHash: styles.size === 1,
    distinctProgramHashes: programHashes.size === results.length,
    pairwiseComparisons,
    crossStorySceneFingerprintOverlap: crossStoryOverlap,
    repetitionReport: repetition,
    passed: styles.size === 1 && programHashes.size === results.length
      && crossStoryOverlap.length === 0 && repetition.passed,
  };
}

export async function renderGeneralizedVisualV2Proof(rawOptions = {}) {
  const options = rawOptions.storyIds
    ? (() => {
      const requireLivePlanner = rawOptions.requireLivePlanner === true;
      const plannerMode = rawOptions.plannerMode
        || (requireLivePlanner ? "live" : "operator");
      if (!PLANNER_MODES.includes(plannerMode)
        || (requireLivePlanner && plannerMode === "operator")) {
        throw new TypeError("Invalid proof planner options.");
      }
      return { ...rawOptions, plannerMode, requireLivePlanner };
    })()
    : parseGeneralizedVisualV2ProofArguments(rawOptions.argv || []);
  const bundles = [];
  for (const storyId of options.storyIds) {
    const baselinePrograms = bundles.map((entry) => ({
      storyId: entry.config.id,
      program: entry.plan,
    }));
    if (options.plannerMode !== "operator" && baselinePrograms.length === 0) {
      const baselineStoryId = GENERALIZED_VISUAL_V2_PROOF_STORY_IDS.find((id) => id !== storyId);
      const baseline = compileGeneralizedVisualV2ProofStory(baselineStoryId);
      baselinePrograms.push({ storyId: baseline.config.id, program: baseline.plan });
    }
    const bundle = await planGeneralizedVisualV2ProofStory(storyId, {
      plannerMode: options.plannerMode,
      requireLivePlanner: options.requireLivePlanner,
      baselinePrograms,
      planner: options.planner,
      env: options.env,
      signal: options.signal,
    });
    bundles.push(bundle);
  }
  const repetition = evaluateVisualProgramV2Repetition(
    bundles.map((bundle) => ({ storyId: bundle.config.id, program: bundle.plan })),
    { failClosed: true },
  );
  if (!repetition.passed) throw new Error("The v2 repetition gate rejected the proof programs.");
  if (options.dryRun || !options.confirmWrite) {
    return freeze({
      mode: "dry_run",
      publishable: false,
      plannerMode: options.plannerMode,
      repetition,
      stories: bundles.map((bundle) => buildGeneralizedVisualV2ProofReport(bundle, { generatedAt: "dry-run" })),
    });
  }
  const results = [];
  for (const bundle of bundles) results.push(await renderStory(bundle));
  const comparison = results.length >= 2
    ? buildGeneralizedVisualV2ComparisonReport(results, repetition)
    : null;
  if (comparison && !comparison.passed) throw new Error("Cross-story composition proof failed.");
  if (comparison) writeJson(absolute("showcase/evidence/generalized-visual-v2-comparison.json"), comparison);
  return freeze({ mode: "write", publishable: false, results, comparison });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseGeneralizedVisualV2ProofArguments(process.argv.slice(2));
    const result = await renderGeneralizedVisualV2Proof(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
