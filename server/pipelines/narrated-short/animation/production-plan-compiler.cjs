const { AppError } = require("../../../errors.cjs");
const { contentHash, normalizeDraftBundle } = require("../contracts.cjs");
const { compileTimingBoundAnimationIR } = require("./compiler.cjs");
const { normalizeAnimationTimingContext } = require("./timing-contract.cjs");

const PRODUCTION_PROVIDER_ID = "hyperframes_local";
const PRODUCTION_RUNTIME_VERSION = "0.7.55";
const PRODUCTION_STYLE_VERSION = "1.3.2";
const TEMPLATE_VERSION = "1.2.0";
const OUTFIT_FONT_SHA256 = "8cfe15c2c6de6ef8efff3eedbd52a383ac9ef23d6c23f6cd9f9b838f5f37dc36";

function unsupported(field) {
  throw new AppError("ANIMATION_TEMPLATE_INVALID", "The approved storyboard cannot be rendered by the production animation grammar.", 409, { field });
}

function wrapText(value, maxCharacters = 22, maxLines = 2) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  for (const word of words) {
    const current = lines.at(-1);
    if (!current || (current.length + word.length + 1 > maxCharacters && lines.length < maxLines)) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`;
  }
  if (!lines.length) lines.push("UNTITLED");
  return lines.slice(0, maxLines).map((line) => line.slice(0, 50));
}

function sceneText(scene, op, fallback = "") {
  const operation = scene.operations.find((candidate) => candidate.op === op);
  return String(operation && (operation.text || operation.label || operation.date) || fallback).trim();
}

function wordIndex(beat, ratio) {
  const count = beat.wordEndIndex - beat.wordStartIndex;
  return Math.min(beat.wordEndIndex - 1, beat.wordStartIndex + Math.max(0, Math.floor((count - 1) * ratio)));
}

function anchor(anchor, extra = {}) { return { anchor, ...extra }; }

function buildProductionAnimationPlan(input = {}) {
  const draft = normalizeDraftBundle(input.draft);
  const timing = normalizeAnimationTimingContext(input.timingContext);
  if (draft.verticalId !== "dark_curiosity" || draft.brief.formatId !== "documented_mystery_v1") unsupported("formatId");
  if (draft.contentHash !== timing.draftHash) unsupported("draftHash");
  const supportedTemplates = new Set(["hook_scene", "evidence_scene", "map_timeline_scene", "system_scale_scene", "payoff_scene"]);
  if (draft.storyboard.scenes.some((scene) => !supportedTemplates.has(scene.template))) unsupported("storyboard.scenes.template");

  const beatById = new Map(timing.beats.map((beat) => [beat.beatId, beat]));
  const scripted = Object.fromEntries(draft.script.beats.map((beat) => [beat.role, beat]));
  for (const role of ["hook", "context", "evidence", "turn", "payoff"]) if (!scripted[role] || !beatById.has(scripted[role].id)) unsupported(`script.${role}`);
  const beats = Object.fromEntries(Object.entries(scripted).map(([role, beat]) => [role, beatById.get(beat.id)]));
  const payoffStart = beats.payoff.startFrame;
  if (payoffStart < 30 || payoffStart >= timing.durationFrames - 6) unsupported("timing.payoff");

  const sceneByTemplate = new Map(draft.storyboard.scenes.map((scene) => [scene.template, scene]));
  const hookScene = sceneByTemplate.get("hook_scene");
  const evidenceScene = sceneByTemplate.get("evidence_scene");
  const systemScene = sceneByTemplate.get("system_scale_scene");
  const turnScene = sceneByTemplate.get("map_timeline_scene");
  const payoffScene = sceneByTemplate.get("payoff_scene");
  if (![hookScene, evidenceScene, systemScene, turnScene, payoffScene].every(Boolean)) unsupported("storyboard.scenes");

  const metricLabel = scripted.context.onScreenText;
  const metricValue = (metricLabel.match(/\b\d[\d.,-]*\b/) || [sceneText(evidenceScene, "show_evidence", "EVIDENCE")])[0];
  const evidenceValue = sceneText(systemScene, "show_evidence", sceneText(systemScene, "connect_nodes", scripted.evidence.onScreenText));
  const content = {
    compositionId: `dc_${draft.contentHash.slice(0, 24)}`,
    kicker: draft.brief.formatId.replace(/_v\d+$/, "").replace(/_/g, " ").toUpperCase(),
    titleLines: wrapText(draft.script.title.toUpperCase(), 20, 2),
    metricValue: metricValue.toUpperCase().slice(0, 32),
    metricLabel: metricLabel.toUpperCase().slice(0, 72),
    evidenceCode: evidenceValue.toUpperCase().slice(0, 32),
    evidenceLabel: scripted.evidence.onScreenText.toUpperCase().slice(0, 72),
    reasoningLeft: "ONE OBSERVATION",
    reasoningRight: "PROOF",
    payoffLines: wrapText(scripted.payoff.onScreenText.toUpperCase(), 24, 2),
    timelineLabels: ["hook", "context", "evidence", "turn", "payoff"].map((role) => role.toUpperCase()),
  };
  const assetManifestHash = contentHash({ grammar: "dark_curiosity_continuous_v1", storyboardHash: draft.storyboard.contentHash, outfitFontSha256: OUTFIT_FONT_SHA256 });
  const seed = Number.parseInt(contentHash({
    draftHash: draft.contentHash,
    fps: timing.fps,
    durationFrames: timing.durationFrames,
    words: timing.words,
    beats: timing.beats,
  }).slice(0, 8), 16) >>> 0;
  const dimensions = input.renderProfile === "final" ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };

  const plan = {
    schemaVersion: 1,
    profile: "dark_curiosity_continuous",
    profileVersion: "1.0.0",
    projectId: String(input.projectId),
    projectRevision: Number(input.projectRevision),
    verticalId: "dark_curiosity",
    ...dimensions,
    fps: timing.fps,
    durationFrames: timing.durationFrames,
    draftHash: draft.contentHash,
    alignmentHash: timing.alignmentHash,
    assetManifestHash,
    renderer: { provider: PRODUCTION_PROVIDER_ID, runtimeVersion: PRODUCTION_RUNTIME_VERSION, styleVersion: PRODUCTION_STYLE_VERSION },
    seed,
    content,
    sharedEntities: [
      { id: "deep_background", type: "background", role: "ambient_field", layer: 0, styleToken: "navy_depth" },
      { id: "signal_grid", type: "grid", role: "evidence_grid", layer: 1, styleToken: "grid_cyan" },
      { id: "signal_wave", type: "waveform", role: "primary_trace", layer: 4, styleToken: "signal_cyan" },
      { id: "signal_pulse", type: "signal_pulse", role: "metric_focus", layer: 5, styleToken: "pulse_white" },
      { id: "beam_alpha", type: "beam", role: "evidence_path_a", layer: 2, styleToken: "beam_violet" },
      { id: "beam_beta", type: "beam", role: "evidence_path_b", layer: 3, styleToken: "beam_amber" },
      { id: "evidence_node", type: "evidence_node", role: "resolved_observation", layer: 6, styleToken: "evidence_cyan", text: content.evidenceCode },
      { id: "payoff_label", type: "label", role: "bounded_conclusion", layer: 7, styleToken: "payoff_amber", text: content.payoffLines.join(" ") },
      { id: "camera_stage", type: "camera_group", role: "primary_camera", layer: 8, styleToken: "camera_neutral" },
    ],
    scenes: [
      {
        id: "scene_explanation", startFrame: 0, endFrame: payoffStart, template: "signal_lab_v1", templateVersion: TEMPLATE_VERSION,
        entityIds: ["deep_background", "signal_grid", "signal_wave", "signal_pulse", "beam_alpha", "beam_beta", "evidence_node", "camera_stage"],
        operations: [
          { op: "create", targetId: "deep_background", from: anchor("absolute", { frame: 0 }), to: anchor("beat_end", { beatId: scripted.turn.id }), easing: "linear", params: { opacity: 1 } },
          { op: "create", targetId: "signal_grid", from: anchor("beat_start", { beatId: scripted.hook.id }), to: anchor("word_end", { wordIndex: wordIndex(beats.hook, 0.18) }), easing: "ease_out_cubic", params: { opacity: 0.75 } },
          { op: "draw_path", targetId: "signal_wave", from: anchor("word_start", { wordIndex: wordIndex(beats.hook, 0.22) }), to: anchor("word_end", { wordIndex: wordIndex(beats.context, 0.42) }), easing: "ease_in_out_cubic", params: { direction: "left_to_right" } },
          { op: "pulse", targetId: "signal_pulse", from: anchor("word_start", { wordIndex: wordIndex(beats.context, 0.44) }), to: anchor("word_end", { wordIndex: wordIndex(beats.context, 0.92) }), easing: "smoothstep", params: { scale: 3.2, opacity: 0.68 } },
          { op: "draw_path", targetId: "beam_alpha", from: anchor("word_start", { wordIndex: wordIndex(beats.evidence, 0.05) }), to: anchor("word_end", { wordIndex: wordIndex(beats.evidence, 0.52) }), easing: "ease_in_out_cubic", params: { direction: "left_to_right" } },
          { op: "draw_path", targetId: "beam_beta", from: anchor("word_start", { wordIndex: wordIndex(beats.evidence, 0.38) }), to: anchor("word_end", { wordIndex: wordIndex(beats.evidence, 0.94) }), easing: "ease_in_out_cubic", params: { direction: "right_to_left" } },
          { op: "camera_push", targetId: "camera_stage", from: anchor("word_start", { wordIndex: wordIndex(beats.turn, 0.48) }), to: anchor("beat_end", { beatId: scripted.turn.id }), easing: "ease_out_cubic", params: { scale: 1.012, x: 0, y: 0 } },
          { op: "morph_path", targetId: "signal_wave", from: anchor("word_start", { wordIndex: wordIndex(beats.turn, 0.02) }), to: anchor("word_end", { wordIndex: wordIndex(beats.turn, 0.82) }), easing: "smoothstep", params: { toShape: "node" } },
        ],
        readabilityHolds: [], complexityCost: 30,
      },
      {
        id: "scene_conclusion", startFrame: payoffStart, endFrame: timing.durationFrames, template: "mystery_payoff_v1", templateVersion: TEMPLATE_VERSION,
        entityIds: ["deep_background", "evidence_node", "payoff_label"],
        operations: [
          { op: "transition_match", targetId: "evidence_node", from: anchor("beat_start", { beatId: scripted.payoff.id }), to: anchor("word_end", { wordIndex: wordIndex(beats.payoff, 0.22) }), easing: "ease_in_out_cubic", params: { toEntityId: "evidence_node" } },
          { op: "scale", targetId: "evidence_node", from: anchor("word_start", { wordIndex: wordIndex(beats.payoff, 0.22) }), to: anchor("word_end", { wordIndex: wordIndex(beats.payoff, 0.46) }), easing: "ease_out_cubic", params: { from: 1, to: 1.08 } },
          { op: "fade", targetId: "payoff_label", from: anchor("word_start", { wordIndex: wordIndex(beats.payoff, 0.48) }), to: anchor("word_end", { wordIndex: wordIndex(beats.payoff, 0.78) }), easing: "ease_in_out_cubic", params: { from: 0, to: 1 } },
          { op: "pulse", targetId: "deep_background", from: anchor("beat_start", { beatId: scripted.payoff.id }), to: anchor("word_end", { wordIndex: wordIndex(beats.payoff, 0.92) }), easing: "smoothstep", params: { scale: 1.04, opacity: 0.22 } },
        ],
        readabilityHolds: timing.durationFrames - beats.payoff.endFrame <= 15 ? [{ startFrame: Math.max(beats.payoff.endFrame, timing.durationFrames - 12), endFrame: timing.durationFrames }] : [], complexityCost: 12,
      },
    ],
    transitions: [{ fromSceneId: "scene_explanation", toSceneId: "scene_conclusion", sharedEntityId: "evidence_node", startFrame: payoffStart, endFrame: Math.min(timing.durationFrames, payoffStart + 23) }],
    motionBudget: { profile: "dark_curiosity", maxCost: 60, maxConcurrentOperations: 8, maxCameraScale: 1.15, maxTravelPxPerFrame: 12, captionSafeZone: { topRatio: 0.74, bottomRatio: 1 } },
  };
  return plan;
}

function compileProductionAnimation(input = {}) {
  const timingContext = normalizeAnimationTimingContext(input.timingContext);
  const plan = buildProductionAnimationPlan({ ...input, timingContext });
  const animationIR = compileTimingBoundAnimationIR(plan, timingContext);
  return Object.freeze({ timingContext, plan: Object.freeze(structuredClone(plan)), animationIR });
}

module.exports = {
  OUTFIT_FONT_SHA256,
  PRODUCTION_PROVIDER_ID,
  PRODUCTION_RUNTIME_VERSION,
  PRODUCTION_STYLE_VERSION,
  buildProductionAnimationPlan,
  compileProductionAnimation,
};
