"use strict";

const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const { normalizeDraftBundle } = require("../contracts.cjs");
const { buildStoryIR } = require("./story-ir.cjs");
const { normalizeAnimationTimingContext } = require("./timing-contract.cjs");
const { compileGeneralizedVisualProgramV1 } = require("./visual-program-compiler.cjs");
const { stableStringify } = require("./canonical-json.cjs");

const CORPUS_SCHEMA_VERSION = 1;
const CORPUS_PROFILE = "generalized_visual_calibration_corpus_v1";
const BASE_FIXTURE = resolve(__dirname, "../../../../eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json");
const RECIPE_TUPLES = Object.freeze({
  finite_cycle: ["finite_cycle", "counter", "update", "match_morph"],
  evidence_inspection: ["evidence_inspection", "document", "reveal", "focus_lens"],
  bounded_uncertainty: ["bounded_uncertainty", "hypothesis", "compare", "scale_focus"],
  map_route: ["map_route", "vessel", "reveal", "match_morph"],
  negative_space_absence: ["negative_space_absence", "signal", "compare", "focus_lens"],
  chronology: ["chronology", "timeline", "resolve", "scale_focus"],
  comparison: ["comparison", "signal", "compare", "scale_focus"],
  cause_effect: ["cause_effect", "receiver", "reveal", "focus_lens"],
});

const DEFINITIONS = Object.freeze([
  {
    id: "calibration_case_01", family: "abstract_mechanism", uncertainty: "verified",
    title: "A counter returning to zero", thesis: "A bounded counter repeats only after exhausting its available states.",
    labels: ["A counter advances", "The final state arrives", "The limit is crossed", "Zero returns", "The cycle repeats"],
    narration: [
      "A small counter advances through one state at a time.",
      "Eventually it reaches the final value its register can hold.",
      "The next update crosses that fixed numerical boundary.",
      "Instead of growing forever, the stored value returns to zero.",
      "The visible reset is therefore a finite cycle, not a random failure.",
    ], recipes: ["finite_cycle", "cause_effect", "comparison"], helper: ["cause_effect", "document"],
  },
  {
    id: "calibration_case_02", family: "documented_mystery", uncertainty: "qualified",
    title: "A mark found on two records", thesis: "A repeated mark is evidence of a pattern but does not identify its maker.",
    labels: ["One mark appears", "A second record matches", "The shapes align", "The origin is uncertain", "Evidence is not identity"],
    narration: [
      "An unusual mark appears in the margin of one archived record.",
      "A second independent record contains a mark with the same outline.",
      "Inspection shows that several distinctive edges align.",
      "The match narrows the possibilities but leaves the origin uncertain.",
      "The records support a relationship, not a confirmed identity.",
    ], recipes: ["evidence_inspection", "bounded_uncertainty", "comparison"], helper: ["bounded_uncertainty", "uncertainty_boundary"],
  },
  {
    id: "calibration_case_03", family: "route_absence", uncertainty: "disputed",
    title: "A vessel missing from its route", thesis: "A gap in observations limits what can be claimed about a route.",
    labels: ["The route begins", "The vessel is observed", "The record stops", "Later traces resume", "The gap remains"],
    narration: [
      "A vessel begins along a route marked by three confirmed observations.",
      "The early positions place it inside the expected corridor.",
      "Then the observation record stops before the central crossing.",
      "A later trace appears farther along the route without showing the missing segment.",
      "The route is partly known, while the unobserved interval remains unresolved.",
    ], recipes: ["map_route", "negative_space_absence", "chronology"], helper: ["negative_space_absence", "uncertainty_boundary"],
  },
  {
    id: "calibration_case_04", family: "causal_system", uncertainty: "verified",
    title: "Pressure changing a valve", thesis: "A threshold explains why a valve changes from closed to open.",
    labels: ["Pressure starts low", "The threshold approaches", "The valve responds", "Flow begins", "Two states explain the change"],
    narration: [
      "At low pressure, a spring keeps the valve in its closed state.",
      "Additional pressure pushes the system toward a measured threshold.",
      "Crossing that threshold overcomes the spring and moves the valve.",
      "The open state then allows a steady flow through the channel.",
      "Comparing the closed and open states makes the causal change visible.",
    ], recipes: ["comparison", "cause_effect", "chronology"], helper: ["cause_effect", "document"],
  },
  {
    id: "calibration_case_05", family: "measurement_change", uncertainty: "qualified",
    title: "A reading before and after calibration", thesis: "Repeated measurement can reveal improvement without claiming perfect accuracy.",
    labels: ["The first reading drifts", "A reference is checked", "Calibration is applied", "The spread narrows", "Accuracy improves with limits"],
    narration: [
      "The first measurement repeatedly drifts away from its known reference.",
      "A controlled reference supplies evidence for the size of that error.",
      "A calibration adjustment changes the instrument response.",
      "Afterward, repeated readings form a visibly narrower spread.",
      "The comparison supports improvement, while residual uncertainty remains.",
    ], recipes: ["evidence_inspection", "comparison", "bounded_uncertainty"], helper: ["evidence_inspection", "document"],
  },
  {
    id: "calibration_case_06", family: "historical_route", uncertainty: "verified",
    title: "Three stations connected over time", thesis: "Ordered records establish a route even when travel between stations is not shown.",
    labels: ["Station one records arrival", "Station two follows", "Station three confirms exit", "The order is fixed", "The route is bounded"],
    narration: [
      "A dated log first records the object at the northern station.",
      "The next confirmed entry places it at the central station.",
      "A final timestamp records its exit from the southern station.",
      "Those observations establish an order without depicting every moment of travel.",
      "The route is supported by three points and bounded by what was observed.",
    ], recipes: ["chronology", "map_route", "negative_space_absence"], helper: ["chronology", "timeline"],
  },
  {
    id: "calibration_case_07", family: "repeating_process", uncertainty: "verified",
    title: "A filter filling and clearing", thesis: "A repeating pressure pattern explains when a filter clears itself.",
    labels: ["Particles collect", "Pressure rises", "A limit is reached", "The filter clears", "The process restarts"],
    narration: [
      "Particles collect inside a filter during each operating interval.",
      "Their accumulation gradually raises pressure across the filter surface.",
      "A sensor records when that pressure reaches a fixed limit.",
      "The limit triggers a reverse pulse that clears the trapped particles.",
      "With the surface clear, the same bounded process begins again.",
    ], recipes: ["finite_cycle", "cause_effect", "evidence_inspection"], helper: ["cause_effect", "document"],
  },
  {
    id: "calibration_case_08", family: "missing_record", uncertainty: "unknown",
    title: "A sequence with one missing page", thesis: "A missing page separates known order from an unknown event.",
    labels: ["The first entry is clear", "One page is absent", "The next entry changes", "The cause is unknown", "Order survives the gap"],
    narration: [
      "The first surviving page describes the system in a stable state.",
      "The following page is absent from the otherwise numbered sequence.",
      "On the next surviving page, the system is already in a changed state.",
      "No available evidence identifies what happened inside the missing interval.",
      "Chronology remains visible, but the cause must stay unknown.",
    ], recipes: ["bounded_uncertainty", "negative_space_absence", "chronology"], helper: ["negative_space_absence", "uncertainty_boundary"],
  },
  {
    id: "calibration_case_09", family: "controlled_test", uncertainty: "qualified",
    title: "Two materials under the same test", thesis: "A controlled comparison supports a relative result rather than a universal claim.",
    labels: ["Two samples begin equal", "One condition is shared", "The responses differ", "The evidence is bounded", "One sample lasts longer here"],
    narration: [
      "Two material samples begin with the same dimensions and measured load.",
      "Both are exposed to one controlled temperature cycle.",
      "Inspection records that the first sample deforms before the second.",
      "The evidence supports a difference under this test, not every possible condition.",
      "Within the bounded experiment, the second sample remains stable for longer.",
    ], recipes: ["comparison", "evidence_inspection", "cause_effect"], helper: ["evidence_inspection", "document"],
  },
  {
    id: "calibration_case_10", family: "signal_route", uncertainty: "disputed",
    title: "A signal crossing a sensor grid", thesis: "A route can be reconstructed while its source remains disputed.",
    labels: ["Sensor one detects a pulse", "The pulse moves east", "Three times establish order", "The source stays disputed", "Route and origin differ"],
    narration: [
      "The western sensor records a brief pulse at the first timestamp.",
      "A central sensor records a similar pulse moments later.",
      "The eastern sensor completes a consistent chronological sequence.",
      "That sequence supports a route, while competing sources remain plausible.",
      "The movement can be mapped even though the origin is disputed.",
    ], recipes: ["map_route", "chronology", "bounded_uncertainty"], helper: ["bounded_uncertainty", "uncertainty_boundary"],
  },
  {
    id: "calibration_case_11", family: "cyclic_observation", uncertainty: "unknown",
    title: "A recurring light with missing intervals", thesis: "Observed recurrence does not fill gaps between measurements.",
    labels: ["The light appears", "The record goes dark", "The light returns", "Intervals can be counted", "The gaps stay unknown"],
    narration: [
      "A light appears during the first scheduled observation window.",
      "No measurement is collected during the next two intervals.",
      "The light returns when observation resumes at the fourth interval.",
      "The visible appearances suggest a cycle that can be compared across windows.",
      "But the unmeasured intervals remain absence, not evidence of darkness.",
    ], recipes: ["negative_space_absence", "finite_cycle", "comparison"], helper: ["negative_space_absence", "uncertainty_boundary"],
  },
  {
    id: "calibration_case_12", family: "mechanism_trace", uncertainty: "qualified",
    title: "A blockage changing downstream flow", thesis: "Location and measurements together support a bounded causal explanation.",
    labels: ["Flow begins evenly", "A blockage forms", "Pressure changes upstream", "The route narrows", "Evidence supports the mechanism"],
    narration: [
      "At first, measurements show an even flow along the entire channel.",
      "A visible blockage then forms near the channel midpoint.",
      "Upstream pressure rises while the downstream reading falls.",
      "Mapping the measurements places the change on opposite sides of the blockage.",
      "Together, location and evidence support a qualified causal explanation.",
    ], recipes: ["cause_effect", "map_route", "evidence_inspection"], helper: ["cause_effect", "document"],
  },
]);

function sha(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

function timingFor(draft, caseId) {
  let frame = 0;
  let wordIndex = 0;
  const words = [];
  const beats = [];
  for (const beat of draft.script.beats) {
    const wordStartIndex = wordIndex;
    for (const wordText of beat.spokenText.split(/\s+/).filter(Boolean)) {
      words.push({ index: wordIndex, text: wordText, startFrame: frame, endFrame: frame + 6 });
      wordIndex += 1;
      frame += 8;
    }
    beats.push({ beatId: beat.id, wordStartIndex, wordEndIndex: wordIndex, startFrame: words[wordStartIndex].startFrame, endFrame: words[wordIndex - 1].endFrame });
    frame += 16;
  }
  return normalizeAnimationTimingContext({
    schemaVersion: 1,
    fps: 30,
    durationFrames: frame + 30,
    alignmentHash: sha(`${caseId}:${draft.contentHash}`),
    draftHash: draft.contentHash,
    words,
    beats,
  });
}

function rawDraftFor(definition) {
  const raw = JSON.parse(readFileSync(BASE_FIXTURE, "utf8"));
  const totalWords = definition.narration.join(" ").split(/\s+/).filter(Boolean).length;
  const calibratedSeconds = Math.max(20, Math.min(45, Math.round(totalWords / 145 * 60)));
  raw.brief.topic = definition.title;
  raw.brief.thesis = definition.thesis;
  raw.brief.targetSeconds = calibratedSeconds;
  raw.brief.operatorNotes = "Operator-created calibration construct. Do not publish as a factual story.";
  raw.claimLedger.sources.forEach((source, index) => {
    source.title = `Operator-created calibration record ${index + 1}`;
    source.publisher = "ShortsEngine calibration corpus";
    source.author = "";
    source.url = `https://example.invalid/${definition.id}/record-${index + 1}`;
    source.verifiedBy = "operator-created";
    source.verifiedAt = "2026-08-02T00:00:00.000Z";
    source.snapshotHash = sha(`${definition.id}:source:${index + 1}`);
    source.sourceClass = "primary";
    source.independenceGroup = `${definition.id}_group_${index + 1}`;
    source.evidenceNote = "Synthetic, rights-safe evidence created only for visual calibration.";
  });
  raw.claimLedger.claims.forEach((claim, index) => {
    const semanticVerdict = definition.uncertainty === "unknown" ? "disputed" : definition.uncertainty;
    claim.text = definition.narration[index];
    claim.kind = semanticVerdict === "verified" ? "supported_fact" : "analysis";
    claim.claimType = semanticVerdict === "verified" ? "verifiable_fact" : semanticVerdict === "qualified" ? "interpretation" : "hypothesis";
    claim.verdict = semanticVerdict;
    claim.sourceLinks.forEach((link) => {
      link.evidenceExcerpt = `Synthetic calibration support for beat ${index + 1}.`;
      link.pageOrTimecode = `calibration-${index + 1}`;
    });
  });
  raw.script.title = definition.title;
  raw.script.estimatedSeconds = calibratedSeconds;
  raw.script.beats.forEach((beat, index) => {
    beat.spokenText = definition.narration[index];
    beat.onScreenText = definition.labels[index];
  });
  raw.script.provider.promptVersion = "generalized_visual_calibration_corpus_v1";
  raw.storyboard.scenes.forEach((scene, index) => {
    scene.operations.forEach((operation) => {
      if (Object.hasOwn(operation, "text")) operation.text = definition.labels[index];
      if (Object.hasOwn(operation, "label")) operation.label = definition.labels[index];
      if (Object.hasOwn(operation, "date")) operation.date = `Stage ${index + 1}`;
    });
    if (scene.disclosure) scene.disclosure = "Illustrative operator-created calibration construct";
  });
  return raw;
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
      const [recipeId, role, action, transitionId] = RECIPE_TUPLES[definition.recipes[index]];
      return {
        id: `visual_scene_${index + 1}`,
        purpose: `Clarify calibration relation ${index + 1}`,
        semanticFamily: recipeId,
        narrationBeatIds: beats.map((beat) => beat.beatId),
        primary: {
          entityRef: beats[0].source.sceneId,
          role,
          recipeId,
          action,
          fromState: `calibration_state_${index + 1}_a`,
          toState: `calibration_state_${index + 1}_b`,
        },
        helper: index === 1 ? { role: definition.helper[1], recipeId: definition.helper[0], dataRefs: [beats[0].claimIds[0]] } : null,
        transitionId,
      };
    }),
  };
}

function compileCalibrationCase(definition) {
  const draft = normalizeDraftBundle(rawDraftFor(definition));
  const timingContext = timingFor(draft, definition.id);
  const storyIR = buildStoryIR({ draft, timingContext });
  const context = { draft, timingContext, storyIR };
  const proposal = proposalFor(definition, context);
  const compiled = compileGeneralizedVisualProgramV1({
    ...context,
    proposal,
    projectId: `project_${definition.id}`,
    projectRevision: 1,
  });
  return Object.freeze({
    corpusCase: Object.freeze({
      caseId: definition.id,
      family: definition.family,
      semanticUncertainty: definition.uncertainty,
      rightsBasis: "operator_created_synthetic_v1",
      sourceDraftHash: draft.contentHash,
      storyIrHash: storyIR.contentHash,
      visualProgramHash: compiled.visualProgram.contentHash,
      recipePlanHash: compiled.visualRecipePlan.contentHash,
      animationIrHash: compiled.animationIR.contentHash,
      recipeIds: Object.freeze([...definition.recipes]),
      helperPresent: Boolean(definition.helper),
    }),
    context,
    proposal,
    compiled,
  });
}

function compileGeneralizedVisualCalibrationCorpus() {
  const cases = DEFINITIONS.map(compileCalibrationCase);
  const recipeSceneCounts = {};
  for (const entry of cases) for (const recipeId of entry.corpusCase.recipeIds) recipeSceneCounts[recipeId] = (recipeSceneCounts[recipeId] || 0) + 1;
  const manifestBase = {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    profile: CORPUS_PROFILE,
    caseCount: cases.length,
    sceneCount: cases.length * 3,
    semanticUncertaintyCoverage: [...new Set(cases.map((entry) => entry.corpusCase.semanticUncertainty))].sort(),
    recipeSceneCounts: Object.fromEntries(Object.entries(recipeSceneCounts).sort(([left], [right]) => left.localeCompare(right))),
    cases: cases.map((entry) => entry.corpusCase),
  };
  const manifest = Object.freeze({ ...manifestBase, contentHash: sha(manifestBase) });
  return Object.freeze({ manifest, cases: Object.freeze(cases) });
}

module.exports = {
  CORPUS_PROFILE,
  DEFINITIONS,
  compileGeneralizedVisualCalibrationCorpus,
};
