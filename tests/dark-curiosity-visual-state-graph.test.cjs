const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { randomUUID } = require("node:crypto");

const { normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const { createAlignment, scriptWords } = require("../server/pipelines/narrated-short/narration/alignment.cjs");
const { buildProductionTimingContext } = require("../server/pipelines/narrated-short/animation/timing-context-builder.cjs");
const { compileProductionAnimation } = require("../server/pipelines/narrated-short/animation/production-plan-compiler.cjs");
const { validateAnimationIR } = require("../server/pipelines/narrated-short/animation/contract.cjs");
const { validateSemanticNarrative } = require("../server/pipelines/narrated-short/animation/semantic-narrative.cjs");
const { buildPacingPlan } = require("../server/pipelines/narrated-short/narration/tts/pacing-plan.cjs");

const FIXTURE = resolve(__dirname, "..", "eval", "narrated", "dark-curiosity", "fixtures", "001_wow_signal_mystery.json");
const art = (letter) => `art_${letter.repeat(40)}`;
const hash = (letter) => letter.repeat(64);

function compiledFixture() {
  const draft = normalizeDraftBundle(JSON.parse(readFileSync(FIXTURE, "utf8")));
  const projectId = `prj_${randomUUID()}`;
  const pacingPlan = buildPacingPlan(draft.script);
  const semanticPausesBefore = new Map(pacingPlan.segments.slice(1).map((segment, index) => [segment.wordStartIndex, pacingPlan.segments[index].pauseAfterMs / 1000]));
  let cursor = 0.08;
  const words = scriptWords(draft.script).map((word, index) => {
    cursor += semanticPausesBefore.get(index) || 0;
    const start = cursor, end = start + 0.31;
    cursor += 0.415;
    return { word: word.text, start, end, probability: 0.99 };
  });
  const durationSeconds = Number((cursor + pacingPlan.segments.at(-1).pauseAfterMs / 1000).toFixed(3));
  const narration = { media: { durationSeconds }, language: "en", voiceProfileId: "voice", rights: { commercialUseAllowed: true, consentReference: "consent" }, draftArtifactId: art("a"), draftHash: draft.contentHash, scriptHash: draft.script.contentHash, audioArtifactId: art("d"), audioHash: hash("d") };
  const alignment = createAlignment({ project: { id: projectId, input: { revision: 1 } }, draft, narration, narrationSummary: { manifestArtifactId: art("c"), manifestHash: hash("c") }, providerResult: { segments: [{ words }] }, provider: { model: "fixture", device: "cpu", computeType: "int8" } });
  const timingContext = buildProductionTimingContext({ draft, alignment, projectId, projectRevision: 1, draftArtifactId: art("a"), draftHash: draft.contentHash, alignmentHash: alignment.contentHash });
  return compileProductionAnimation({ draft, timingContext, projectId, projectRevision: 1, renderProfile: "preview" }).animationIR;
}

function expectInvalid(base, mutate, code) {
  const candidate = structuredClone(base);
  mutate(candidate);
  delete candidate.contentHash;
  if (candidate.visualStateGraph) delete candidate.visualStateGraph.contentHash;
  assert.throws(() => validateAnimationIR(candidate), (error) => error?.code === code);
}

test("Visual State Graph is exact, connected, hash-bound, and identity-preserving", () => {
  const ir = compiledFixture();
  const graph = ir.visualStateGraph;
  assert.deepEqual(graph.states.map((state) => state.id), ["observation_record", "frequency_context", "beam_response", "failed_repeat_search", "bounded_candidate"]);
  assert.deepEqual(graph.stateTransitions.map((transition) => [transition.fromStateId, transition.toStateId]), [["observation_record", "frequency_context"], ["frequency_context", "beam_response"], ["beam_response", "failed_repeat_search"], ["failed_repeat_search", "bounded_candidate"]]);
  assert.equal(graph.persistentEntities.length, 1);
  assert.equal(graph.persistentEntities[0].id, "signal_evidence");
  assert.equal(new Set(graph.persistentEntities[0].representations.map((representation) => representation.pointCount)).size, 1);
  assert.ok(graph.continuityBindings.every((binding) => binding.persistentEntityId === "signal_evidence" && binding.preserveIdentity === true && binding.interpolation === "matched_control_points"));
  assert.equal(graph.bindings.draftHash, ir.draftHash);
  assert.equal(graph.bindings.alignmentHash, ir.alignmentHash);
  assert.equal(graph.bindings.timingContextHash, ir.timingBinding.timingContextHash);
});

test("Visual State Graph rejects missing, disconnected, cyclic, unknown, or desynchronized state data", () => {
  const base = compiledFixture();
  expectInvalid(base, (ir) => { delete ir.visualStateGraph; }, "ANIMATION_IR_INVALID");
  expectInvalid(base, (ir) => { ir.visualStateGraph.bindings.timingContextHash = hash("f"); }, "ANIMATION_VISUAL_STATE_INVALID");
  expectInvalid(base, (ir) => { ir.visualStateGraph.states[1].id = "observation_record"; }, "ANIMATION_VISUAL_STATE_INVALID");
  expectInvalid(base, (ir) => { ir.visualStateGraph.states[0].supportingEntityIds[0] = "unknown_entity"; }, "ANIMATION_VISUAL_STATE_INVALID");
  expectInvalid(base, (ir) => { ir.visualStateGraph.states[2].claimIds = ["claim_unknown"]; }, "ANIMATION_VISUAL_STATE_INVALID");
  expectInvalid(base, (ir) => { ir.visualStateGraph.states[2].settleAnchor.resolvedFrame += 1; }, "ANIMATION_VISUAL_STATE_INVALID");
  expectInvalid(base, (ir) => { ir.visualStateGraph.stateTransitions[1].fromStateId = "bounded_candidate"; }, "ANIMATION_VISUAL_STATE_INVALID");
  expectInvalid(base, (ir) => { ir.visualStateGraph.stateTransitions[2].toStateId = "frequency_context"; }, "ANIMATION_VISUAL_STATE_INVALID");
  expectInvalid(base, (ir) => { ir.visualStateGraph.persistentEntities[0].representations[2].pointCount = 127; }, "ANIMATION_VISUAL_STATE_INVALID");
  expectInvalid(base, (ir) => { ir.visualStateGraph.persistentEntities[0].representations[3].geometryToken = "remote_geometry_v1"; }, "ANIMATION_VISUAL_STATE_INVALID");
  expectInvalid(base, (ir) => { ir.visualStateGraph.continuityBindings[0].fromRepresentationId = "signal_candidate_rep"; }, "ANIMATION_VISUAL_STATE_INVALID");
  expectInvalid(base, (ir) => { ir.visualStateGraph.continuityBindings[1].preserveIdentity = false; }, "ANIMATION_VISUAL_STATE_INVALID");

  expectInvalid(base, (ir) => {
    const transition = ir.visualStateGraph.stateTransitions[0];
    const state = ir.visualStateGraph.states[1];
    transition.toAnchor.offsetFrames = 17;
    transition.toAnchor.resolvedFrame = transition.fromAnchor.resolvedFrame + 17;
    state.settleAnchor.offsetFrames = 17;
    state.settleAnchor.resolvedFrame = transition.toAnchor.resolvedFrame;
  }, "ANIMATION_VISUAL_STATE_INVALID");

  const tamperedHash = structuredClone(base);
  delete tamperedHash.contentHash;
  tamperedHash.visualStateGraph.contentHash = hash("f");
  assert.throws(() => validateAnimationIR(tamperedHash), { code: "ANIMATION_VISUAL_STATE_INVALID" });

  const executable = structuredClone(base);
  delete executable.contentHash;
  executable.visualStateGraph.states[0].semanticStatement = "https://remote.invalid/asset";
  assert.throws(() => validateAnimationIR(executable), { code: "ANIMATION_IR_INVALID" });
});

test("Focus Director rejects gaps, competing primaries, short settles, and state-frame lies", () => {
  const base = compiledFixture();
  expectInvalid(base, (ir) => { ir.visualStateGraph.focusIntervals[1].startFrame += 1; }, "ANIMATION_FOCUS_INVALID");
  expectInvalid(base, (ir) => { ir.visualStateGraph.focusIntervals[1].startFrame -= 1; }, "ANIMATION_FOCUS_INVALID");
  expectInvalid(base, (ir) => { ir.visualStateGraph.focusIntervals[0].supportingEntityIds.push("signal_evidence"); }, "ANIMATION_FOCUS_INVALID");
  expectInvalid(base, (ir) => { ir.visualStateGraph.focusIntervals[2].primaryEntityId = "unknown_entity"; }, "ANIMATION_FOCUS_INVALID");
  expectInvalid(base, (ir) => { const interval = ir.visualStateGraph.focusIntervals[3]; interval.settleFrame = interval.endFrame - 17; }, "ANIMATION_FOCUS_INVALID");
  expectInvalid(base, (ir) => { ir.visualStateGraph.focusIntervals.find((interval) => interval.id === "focus_turn_searches").settleFrame -= 1; }, "ANIMATION_FOCUS_INVALID");
  expectInvalid(base, (ir) => { const interval = ir.visualStateGraph.focusIntervals[3]; interval.dimmedOpacity = interval.supportingOpacity; }, "ANIMATION_FOCUS_INVALID");
  expectInvalid(base, (ir) => { ir.visualStateGraph.semanticMotionConcurrency.maxSupportingActions = 1; }, "ANIMATION_FOCUS_INVALID");
  expectInvalid(base, (ir) => { ir.visualStateGraph.semanticMotionConcurrency.ambientEntityIds.push("search_timeline"); }, "ANIMATION_FOCUS_INVALID");
  expectInvalid(base, (ir) => {
    const interval = ir.visualStateGraph.focusIntervals[0];
    interval.stateId = "frequency_context";
    interval.claimId = "claim_frequency";
    interval.supportingEntityIds = ["frequency_scale"];
  }, "ANIMATION_FOCUS_INVALID");
});

test("root scene transitions cannot drift from persistent graph transitions", () => {
  const base = compiledFixture();
  const wrongEntity = structuredClone(base);
  wrongEntity.transitions[0].sharedEntityId = "deep_background";
  assert.throws(() => validateSemanticNarrative(wrongEntity), { code: "ANIMATION_SEMANTIC_INVALID" });
  const wrongTiming = structuredClone(base);
  wrongTiming.transitions[0].endFrame += 1;
  assert.throws(() => validateSemanticNarrative(wrongTiming), { code: "ANIMATION_SEMANTIC_INVALID" });
  const extraTransition = structuredClone(base);
  extraTransition.transitions.push(structuredClone(extraTransition.transitions.at(-1)));
  assert.throws(() => validateSemanticNarrative(extraTransition), { code: "ANIMATION_SEMANTIC_INVALID" });
});
