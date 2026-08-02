"use strict";

const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { normalizeDraftBundle } = require("../../server/pipelines/narrated-short/contracts.cjs");
const { buildStoryIR } = require("../../server/pipelines/narrated-short/animation/story-ir.cjs");
const { normalizeAnimationTimingContext } = require("../../server/pipelines/narrated-short/animation/timing-contract.cjs");
const { compileGeneralizedVisualProgramV1 } = require("../../server/pipelines/narrated-short/animation/visual-program-compiler.cjs");

const ROOT = resolve(__dirname, "../..");
const CASES = Object.freeze([
  Object.freeze({
    fixtureId: "001_wow_signal_mystery",
    projectId: "project_recipe_signal",
    sequence: [
      ["evidence_inspection", "document", "reveal", "focus_lens"],
      ["bounded_uncertainty", "hypothesis", "compare", "scale_focus"],
      ["comparison", "signal", "resolve", "none"],
    ],
    helper: ["bounded_uncertainty", "uncertainty_boundary"],
  }),
  Object.freeze({
    fixtureId: "002_gps_week_rollover",
    projectId: "project_recipe_cycle",
    sequence: [
      ["finite_cycle", "counter", "update", "match_morph"],
      ["cause_effect", "receiver", "reveal", "focus_lens"],
      ["comparison", "counter", "compare", "none"],
    ],
    helper: ["cause_effect", "document"],
  }),
  Object.freeze({
    fixtureId: "003_baychimo_icebound_drift",
    projectId: "project_recipe_route",
    sequence: [
      ["map_route", "vessel", "reveal", "match_morph"],
      ["negative_space_absence", "vessel", "compare", "focus_lens"],
      ["chronology", "timeline", "resolve", "none"],
    ],
    helper: ["negative_space_absence", "uncertainty_boundary"],
  }),
]);

function timingFor(draft, salt, frameScale = 1) {
  let frame = 0;
  let wordIndex = 0;
  const words = [];
  const beats = [];
  for (const beat of draft.script.beats) {
    const wordStartIndex = wordIndex;
    for (const wordText of beat.spokenText.split(/\s+/).filter(Boolean)) {
      const wordLength = Math.max(4, Math.round(6 * frameScale));
      words.push({ index: wordIndex, text: wordText, startFrame: frame, endFrame: frame + wordLength });
      wordIndex += 1;
      frame += Math.max(6, Math.round(8 * frameScale));
    }
    beats.push({
      beatId: beat.id,
      wordStartIndex,
      wordEndIndex: wordIndex,
      startFrame: words[wordStartIndex].startFrame,
      endFrame: words[wordIndex - 1].endFrame,
    });
    frame += Math.max(10, Math.round(16 * frameScale));
  }
  return normalizeAnimationTimingContext({
    schemaVersion: 1,
    fps: 30,
    durationFrames: frame + 30,
    alignmentHash: createHash("sha256").update(`${salt}:${frameScale}:${draft.contentHash}`).digest("hex"),
    draftHash: draft.contentHash,
    words,
    beats,
  });
}

function contextFor(definition, frameScale = 1) {
  const raw = JSON.parse(readFileSync(resolve(ROOT, "eval/narrated/dark-curiosity/fixtures", `${definition.fixtureId}.json`), "utf8"));
  const draft = normalizeDraftBundle(raw);
  const timingContext = timingFor(draft, definition.fixtureId, frameScale);
  const storyIR = buildStoryIR({ draft, timingContext });
  return { draft, timingContext, storyIR };
}

function proposalFor(definition, context) {
  const groups = [context.storyIR.beats.slice(0, 2), context.storyIR.beats.slice(2, 4), context.storyIR.beats.slice(4)];
  return {
    schemaVersion: 1,
    profile: "generalized_visual_program_proposal_v1",
    bindings: {
      storyIrHash: context.storyIR.contentHash,
      timingContextHash: context.timingContext.contentHash,
      draftHash: context.storyIR.bindings.draftHash,
      sourceRevisionHash: context.storyIR.bindings.sourceStoryboardHash,
    },
    styleTokenId: "line_art_dark_v1",
    scenes: groups.map((beats, index) => {
      const [recipeId, role, action, transitionId] = definition.sequence[index];
      return {
        id: `visual_scene_${index + 1}`,
        purpose: `Clarify narrated evidence group ${index + 1}`,
        semanticFamily: recipeId,
        narrationBeatIds: beats.map((beat) => beat.beatId),
        primary: {
          entityRef: beats[0].source.sceneId,
          role,
          recipeId,
          action,
          fromState: `evidence_state_${index + 1}`,
          toState: `resolved_state_${index + 1}`,
        },
        helper: index === 1 ? { role: definition.helper[1], recipeId: definition.helper[0], dataRefs: [beats[0].claimIds[0]] } : null,
        transitionId,
      };
    }),
  };
}

function compileCase(definition, frameScale = 1) {
  const context = contextFor(definition, frameScale);
  const proposal = proposalFor(definition, context);
  const compiled = compileGeneralizedVisualProgramV1({
    ...context,
    proposal,
    projectId: definition.projectId,
    projectRevision: 1,
  });
  return { context, proposal, compiled };
}

module.exports = { CASES, compileCase, contextFor, proposalFor };
