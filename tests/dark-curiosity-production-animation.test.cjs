const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require("node:fs");
const { resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID } = require("node:crypto");

const { normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const { createAlignment, scriptWords } = require("../server/pipelines/narrated-short/narration/alignment.cjs");
const { buildProductionTimingContext } = require("../server/pipelines/narrated-short/animation/timing-context-builder.cjs");
const { buildProductionAnimationPlan, compileProductionAnimation } = require("../server/pipelines/narrated-short/animation/production-plan-compiler.cjs");
const { browserResultMeetsPolicy, runProductionAnimationRender, safeSeekSequence } = require("../server/pipelines/narrated-short/animation/render-service.cjs");
const { validateSemanticNarrative } = require("../server/pipelines/narrated-short/animation/semantic-narrative.cjs");
const { validateAnimationIR } = require("../server/pipelines/narrated-short/animation/contract.cjs");
const { MINIMUM_FINAL_HOLD_FRAMES, MINIMUM_OPERATION_FRAMES, MINIMUM_SCENE_HOLD_FRAMES, validateAnimationComprehensionPacing } = require("../server/pipelines/narrated-short/animation/comprehension-pacing.cjs");
const { focusMotionBinding } = require("../server/pipelines/narrated-short/animation/focus-director.cjs");
const { buildPacingPlan } = require("../server/pipelines/narrated-short/narration/tts/pacing-plan.cjs");
const { contentHash } = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  DEFAULT_MOTION_THRESHOLD,
  MOTION_ANALYSIS_PROFILE_ID,
  READABILITY_HOLD_POLICY_ID,
  SEGMENT_POLICY_ID,
  motionAnalysisConfigurationHash,
  motionAnalysisDimensions,
  motionAnalysisRangeHash,
} = require("../server/pipelines/narrated-short/animation/benchmark-qa.cjs");

const FIXTURE = resolve(__dirname, "..", "eval", "narrated", "dark-curiosity", "fixtures", "001_wow_signal_mystery.json");
const art = (letter) => `art_${letter.repeat(40)}`;
const hash = (letter) => letter.repeat(64);

function mockMotionEvidence(request) {
  const dimensions = motionAnalysisDimensions(
    request.geometryAudit.semanticRoi,
    { width: request.width, height: request.height },
  );
  const readabilityHoldRangesHash = motionAnalysisRangeHash(
    READABILITY_HOLD_POLICY_ID,
    request.readabilityHolds,
  );
  const segmentRangesHash = motionAnalysisRangeHash(
    SEGMENT_POLICY_ID,
    request.segments,
  );
  return {
    motionAnalysisProfileId: MOTION_ANALYSIS_PROFILE_ID,
    readabilityHoldPolicyId: READABILITY_HOLD_POLICY_ID,
    segmentPolicyId: SEGMENT_POLICY_ID,
    analysisWidth: dimensions.width,
    analysisHeight: dimensions.height,
    motionThreshold: DEFAULT_MOTION_THRESHOLD,
    readabilityHoldRangesHash,
    segmentRangesHash,
    motionConfigurationHash: motionAnalysisConfigurationHash({
      motionAnalysisProfileId: MOTION_ANALYSIS_PROFILE_ID,
      readabilityHoldPolicyId: READABILITY_HOLD_POLICY_ID,
      segmentPolicyId: SEGMENT_POLICY_ID,
      analysisWidth: dimensions.width,
      analysisHeight: dimensions.height,
      motionThreshold: DEFAULT_MOTION_THRESHOLD,
      readabilityHoldRangesHash,
      segmentRangesHash,
    }),
  };
}

function productionFixture(options = {}) {
  const rawDraft = JSON.parse(readFileSync(FIXTURE, "utf8"));
  if (options.trailingPayoffText) {
    rawDraft.script.beats.at(-1).spokenText += ` ${options.trailingPayoffText}`;
    rawDraft.script.estimatedSeconds = Math.min(45, rawDraft.script.estimatedSeconds + 3);
  }
  const draft = normalizeDraftBundle(rawDraft);
  const projectId = `prj_${randomUUID()}`;
  const expected = scriptWords(draft.script);
  const pacingPlan = options.useCanonicalPacing === false ? null : buildPacingPlan(draft.script);
  const semanticPausesBefore = options.semanticPausesBefore || new Map(pacingPlan ? pacingPlan.segments.slice(1).map((segment, index) => [segment.wordStartIndex, pacingPlan.segments[index].pauseAfterMs / 1000]) : []);
  const wordDuration = options.wordDuration ?? 0.31;
  const wordStep = options.wordStep ?? 0.415;
  let cursor = options.cursorStart ?? 0.08;
  const words = expected.map((word, index) => {
    cursor += semanticPausesBefore.get(index) || 0;
    const start = cursor;
    const end = start + (options.wordDurationFor?.(index) ?? wordDuration);
    cursor += options.wordStepFor?.(index) ?? wordStep;
    return { word: word.text, start, end, probability: 0.99 };
  });
  const durationSeconds = options.durationSeconds ?? Number((cursor + (pacingPlan ? pacingPlan.segments.at(-1).pauseAfterMs / 1000 : options.finalPauseSeconds ?? 1.2)).toFixed(3));
  const narration = { media: { durationSeconds }, language: "en", voiceProfileId: "voice", rights: { commercialUseAllowed: true, consentReference: "consent" }, draftArtifactId: art("a"), draftHash: draft.contentHash, scriptHash: draft.script.contentHash, audioArtifactId: art("d"), audioHash: hash("d") };
  const summary = { manifestArtifactId: art("c"), manifestHash: hash("c") };
  const alignment = createAlignment({ project: { id: projectId, input: { revision: 1 } }, draft, narration, narrationSummary: summary, providerResult: { segments: [{ words }] }, provider: { model: "fixture", device: "cpu", computeType: "int8" } });
  const timingContext = buildProductionTimingContext({ draft, alignment, projectId, projectRevision: 1, draftArtifactId: art("a"), draftHash: draft.contentHash, alignmentHash: alignment.contentHash });
  return { draft, projectId, alignment, timingContext };
}

test("production timing context is derived from exact approved alignment", () => {
  const value = productionFixture();
  assert.equal(value.timingContext.words.length, 81);
  assert.equal(value.timingContext.durationFrames, value.alignment.durationFrames);
  assert.deepEqual(value.timingContext.beats.map((beat) => beat.beatId), value.draft.script.beats.map((beat) => beat.id));
  assert.equal(buildProductionTimingContext({ draft: value.draft, alignment: value.alignment, draftArtifactId: art("a"), draftHash: value.draft.contentHash, alignmentHash: value.alignment.contentHash }).contentHash, value.timingContext.contentHash);
  assert.throws(() => buildProductionTimingContext({ draft: value.draft, alignment: value.alignment, draftArtifactId: art("a"), draftHash: hash("f"), alignmentHash: value.alignment.contentHash }), { code: "ANIMATION_TIMING_BINDING_MISMATCH" });
});

test("production plan and AnimationIR are deterministic and data-bound", () => {
  const value = productionFixture();
  const input = { draft: value.draft, timingContext: value.timingContext, projectId: value.projectId, projectRevision: 1, renderProfile: "preview" };
  const first = compileProductionAnimation(input);
  const second = compileProductionAnimation(input);
  const independent = productionFixture();
  const independentPlan = compileProductionAnimation({ draft: independent.draft, timingContext: independent.timingContext, projectId: independent.projectId, projectRevision: 1, renderProfile: "preview" });
  assert.equal(first.animationIR.contentHash, second.animationIR.contentHash);
  assert.notEqual(value.projectId, independent.projectId);
  assert.notEqual(value.alignment.contentHash, independent.alignment.contentHash);
  assert.equal(first.animationIR.seed, independentPlan.animationIR.seed);
  assert.deepEqual(first.animationIR.scenes.map((scene) => scene.id), ["scene_hook", "scene_context", "scene_evidence", "scene_turn", "scene_payoff"]);
  assert.deepEqual(first.animationIR.scenes.map((scene) => scene.template), ["wow_observation_v1", "frequency_duration_v1", "telescope_beam_v1", "repeat_search_v1", "evidence_payoff_v1"]);
  assert.deepEqual(first.animationIR.scenes.map((scene) => scene.semantic.role), ["hook", "context", "evidence", "turn", "payoff"]);
  const operations = new Map(first.animationIR.scenes.flatMap((scene) => scene.operations).map((operation) => [`${operation.op}:${operation.targetId}`, operation]));
  assert.deepEqual([operations.get("highlight:wow_annotation").from.wordIndex, operations.get("highlight:wow_annotation").to.wordIndex], [11, 14]);
  assert.equal(operations.get("create:frequency_scale").to.wordIndex, 19);
  assert.deepEqual([operations.get("pulse:duration_timer").from.wordIndex, operations.get("pulse:duration_timer").to.wordIndex], [27, 29]);
  assert.deepEqual([operations.get("trace_signal:evidence_trace").from.wordIndex, operations.get("trace_signal:evidence_trace").to.wordIndex], [31, 34]);
  assert.deepEqual([operations.get("draw_path:beam_graph").from.wordIndex, operations.get("draw_path:beam_graph").to.wordIndex], [35, 41]);
  assert.deepEqual([operations.get("highlight:no_repeat_label").from.wordIndex, operations.get("highlight:no_repeat_label").to.wordIndex], [55, 58]);
  assert.deepEqual([operations.get("highlight:final_evidence_label").from.wordIndex, operations.get("highlight:final_evidence_label").to.wordIndex], [78, 80]);
  assert.deepEqual(validateSemanticNarrative(first.animationIR), { valid: true, mode: "semantic", beatCount: 5, cueCount: 17 });
  const seekSequence = safeSeekSequence(first.animationIR);
  for (const scene of first.animationIR.scenes) assert.ok(seekSequence.includes(Math.floor((scene.startFrame + scene.endFrame - 1) / 2)));
  assert.ok(seekSequence.length <= 40);
  for (const state of first.animationIR.visualStateGraph.states) assert.ok(seekSequence.includes(state.settleAnchor.resolvedFrame), state.id);
  for (const transition of first.animationIR.visualStateGraph.stateTransitions) {
    assert.ok(seekSequence.includes(transition.fromAnchor.resolvedFrame), `${transition.id}:start`);
    assert.ok(seekSequence.includes(Math.floor((transition.fromAnchor.resolvedFrame + transition.toAnchor.resolvedFrame) / 2)), `${transition.id}:mid`);
    assert.ok(seekSequence.includes(transition.toAnchor.resolvedFrame), `${transition.id}:end`);
  }
  for (const interval of first.animationIR.visualStateGraph.focusIntervals) {
    assert.ok(seekSequence.includes(Math.floor((interval.startFrame + interval.endFrame - 1) / 2)), interval.id);
    const motion = focusMotionBinding(interval, {
      scenes: first.animationIR.scenes,
      stateTransitions: first.animationIR.visualStateGraph.stateTransitions,
      ambientEntityIds: first.animationIR.visualStateGraph.semanticMotionConcurrency.ambientEntityIds,
    });
    assert.notEqual(motion.actualMotionEnd, null, `${interval.id}:motion`);
    assert.equal(interval.settleFrame, motion.actualMotionEnd, `${interval.id}:settle`);
    assert.ok(interval.endFrame - interval.settleFrame >= 18, `${interval.id}:hold`);
  }
  assert.equal(first.animationIR.timingBinding.timingContextHash, value.timingContext.contentHash);
  assert.equal(first.animationIR.durationFrames, value.alignment.durationFrames);
  assert.equal(first.animationIR.renderer.provider, "hyperframes_local");
  assert.equal(first.animationIR.renderer.styleVersion, "1.9.0");
  assert.deepEqual(first.animationIR.visualStateGraph.states.map((state) => state.id), ["observation_record", "frequency_context", "beam_response", "failed_repeat_search", "bounded_candidate"]);
  assert.deepEqual(first.animationIR.visualStateGraph.stateTransitions.map((transition) => [transition.fromStateId, transition.toStateId]), [["observation_record", "frequency_context"], ["frequency_context", "beam_response"], ["beam_response", "failed_repeat_search"], ["failed_repeat_search", "bounded_candidate"]]);
  assert.ok(first.animationIR.transitions.every((transition) => transition.sharedEntityId === "signal_evidence"));
  assert.equal(first.animationIR.content.semantic.profileId, "wow_signal_case_v1");
  assert.equal(first.animationIR.content.semantic.eventYearLabel, "1977");
  assert.equal(first.animationIR.content.semantic.sourceLabel, "PROMISING COMMUNICATION BAND");
  assert.equal(first.animationIR.content.metricValue, "72");
  assert.deepEqual(first.animationIR.content.payoffLines, ["UNEXPLAINED IS NOT PROOF"]);

  const stagger = operations.get("stagger:search_timeline");
  const noRepeat = operations.get("highlight:no_repeat_label");
  assert.ok(noRepeat.from.resolvedFrame > stagger.from.resolvedFrame + Math.floor((stagger.to.resolvedFrame - stagger.from.resolvedFrame) * 0.65));
  for (const [key, minimumFrames] of Object.entries(MINIMUM_OPERATION_FRAMES)) {
    const operation = operations.get(key);
    assert.ok(operation.to.resolvedFrame - operation.from.resolvedFrame >= minimumFrames, key);
  }
  assert.ok(first.animationIR.scenes.every((scene) => scene.readabilityHolds.length === 1));
  for (const scene of first.animationIR.scenes.slice(0, -1)) {
    const hold = scene.readabilityHolds[0];
    assert.equal(hold.endFrame, scene.endFrame);
    assert.ok(hold.endFrame - hold.startFrame >= MINIMUM_SCENE_HOLD_FRAMES, scene.id);
  }
  const finalHold = first.animationIR.scenes.at(-1).readabilityHolds.at(-1);
  assert.ok(finalHold.startFrame > operations.get("highlight:final_evidence_label").to.resolvedFrame);
  assert.ok(finalHold.endFrame - finalHold.startFrame >= MINIMUM_FINAL_HOLD_FRAMES);
  assert.equal(validateAnimationComprehensionPacing(first.animationIR).valid, true);
});

test("focus timing allocator preserves full comprehension holds for a compact valid alignment", () => {
  const compact = productionFixture({
    cursorStart: 0.2,
    wordDuration: 0.25,
    wordStep: 0.32,
    durationSeconds: 32,
    semanticPausesBefore: new Map([[15, 0.45], [30, 0.45], [48, 0.45], [57, 0.45], [64, 0.45]]),
  });
  const ir = compileProductionAnimation({ draft: compact.draft, timingContext: compact.timingContext, projectId: compact.projectId, projectRevision: 1, renderProfile: "preview" }).animationIR;
  for (const [key, minimumFrames] of Object.entries(MINIMUM_OPERATION_FRAMES)) {
    const operation = ir.scenes.flatMap((scene) => scene.operations).find((candidate) => `${candidate.op}:${candidate.targetId}` === key);
    assert.ok(operation.to.resolvedFrame - operation.from.resolvedFrame >= minimumFrames, key);
  }
  for (const interval of ir.visualStateGraph.focusIntervals) {
    const motion = focusMotionBinding(interval, { scenes: ir.scenes, stateTransitions: ir.visualStateGraph.stateTransitions, ambientEntityIds: ir.visualStateGraph.semanticMotionConcurrency.ambientEntityIds });
    assert.equal(interval.settleFrame, motion.actualMotionEnd, `${interval.id}:settle`);
    assert.ok(interval.endFrame - interval.settleFrame >= 18, `${interval.id}:hold`);
  }
  assert.equal(validateAnimationComprehensionPacing(ir).valid, true);
});

test("final readability hold starts after clamped terminal motion instead of the raw proof word", () => {
  const value = productionFixture({
    trailingPayoffText: "Only a recording nobody reproduced.",
    useCanonicalPacing: false,
    semanticPausesBefore: new Map([[15, 0.45], [30, 0.45], [48, 0.45], [57, 0.45], [64, 0.45]]),
    wordDurationFor: (index) => index >= 78 ? 0.1 : 0.31,
    wordStepFor: (index) => index === 78 || index === 79 ? 0.12 : 0.415,
  });
  const ir = compileProductionAnimation({ draft: value.draft, timingContext: value.timingContext, projectId: value.projectId, projectRevision: 1, renderProfile: "preview" }).animationIR;
  const finalScene = ir.scenes.at(-1);
  const terminalMotionEnd = Math.max(...finalScene.operations.map((operation) => operation.to.resolvedFrame));
  const proofWord = value.timingContext.words.find((word) => String(word.text).toLowerCase().replace(/[^a-z]/g, "") === "proof");
  const finalHold = finalScene.readabilityHolds.at(-1);
  assert.ok(terminalMotionEnd > proofWord.endFrame - 1);
  assert.equal(finalHold.startFrame, terminalMotionEnd + 1);
  assert.ok(finalHold.endFrame - finalHold.startFrame >= MINIMUM_FINAL_HOLD_FRAMES);
  assert.equal(validateAnimationComprehensionPacing(ir).valid, true);
});

test("comprehension pacing rejects compressed claim motion and fake overlapping holds", () => {
  const value = productionFixture();
  const animationIR = structuredClone(compileProductionAnimation({ draft: value.draft, timingContext: value.timingContext, projectId: value.projectId, projectRevision: 1, renderProfile: "preview" }).animationIR);
  const compressed = structuredClone(animationIR);
  const verdict = compressed.scenes.at(-1).operations.find((operation) => operation.targetId === "final_evidence_label");
  verdict.to.resolvedFrame = verdict.from.resolvedFrame + MINIMUM_OPERATION_FRAMES["highlight:final_evidence_label"] - 1;
  assert.throws(() => validateAnimationComprehensionPacing(compressed), { code: "ANIMATION_PACING_INVALID" });

  const overlapping = structuredClone(animationIR);
  overlapping.scenes.at(-1).readabilityHolds[0].startFrame = overlapping.scenes.at(-1).operations.find((operation) => operation.targetId === "final_evidence_label").to.resolvedFrame;
  assert.throws(() => validateAnimationComprehensionPacing(overlapping), { code: "ANIMATION_PACING_INVALID" });

  const rushedHold = structuredClone(animationIR);
  rushedHold.scenes[0].readabilityHolds[0].startFrame = rushedHold.scenes[0].endFrame - MINIMUM_SCENE_HOLD_FRAMES + 1;
  assert.throws(() => validateAnimationComprehensionPacing(rushedHold), { code: "ANIMATION_PACING_INVALID" });

  const falseFocusSettle = structuredClone(animationIR);
  falseFocusSettle.visualStateGraph.focusIntervals.find((interval) => interval.id === "focus_turn_searches").settleFrame -= 1;
  assert.throws(() => validateAnimationComprehensionPacing(falseFocusSettle), { code: "ANIMATION_PACING_INVALID" });

  const crossingMotion = structuredClone(animationIR);
  crossingMotion.scenes.find((scene) => scene.id === "scene_turn").operations.find((operation) => operation.targetId === "search_timeline").to.resolvedFrame += 1;
  assert.throws(() => validateAnimationComprehensionPacing(crossingMotion), { code: "ANIMATION_PACING_INVALID" });
});

test("semantic production profile fails closed on missing narration cues and metadata", () => {
  const value = productionFixture();
  const missingCue = structuredClone(value.timingContext);
  delete missingCue.contentHash;
  missingCue.words[14].text = "Different";
  assert.throws(() => buildProductionAnimationPlan({ draft: value.draft, timingContext: missingCue, projectId: value.projectId, projectRevision: 1, renderProfile: "preview" }), { code: "ANIMATION_TEMPLATE_INVALID" });
  const compiled = structuredClone(compileProductionAnimation({ draft: value.draft, timingContext: value.timingContext, projectId: value.projectId, projectRevision: 1, renderProfile: "preview" }).animationIR);
  delete compiled.scenes[2].operations[0].visualStatement;
  assert.throws(() => validateSemanticNarrative(compiled), { code: "ANIMATION_SEMANTIC_INVALID" });

  const uncoveredClaim = structuredClone(compileProductionAnimation({ draft: value.draft, timingContext: value.timingContext, projectId: value.projectId, projectRevision: 1, renderProfile: "preview" }).animationIR);
  uncoveredClaim.scenes[2].semantic.claimIds.push("claim_uncovered");
  assert.throws(() => validateSemanticNarrative(uncoveredClaim), { code: "ANIMATION_SEMANTIC_INVALID" });

  const futureCarry = structuredClone(compileProductionAnimation({ draft: value.draft, timingContext: value.timingContext, projectId: value.projectId, projectRevision: 1, renderProfile: "preview" }).animationIR);
  futureCarry.scenes[2].operations.find((operation) => operation.targetId === "evidence_trace").carryPolicy = "clear_at_scene_end";
  futureCarry.scenes[3].operations.find((operation) => operation.targetId === "evidence_trace").carryPolicy = "carry_to_next";
  assert.throws(() => validateSemanticNarrative(futureCarry), { code: "ANIMATION_SEMANTIC_INVALID" });

  const legacyWithSemanticVersion = structuredClone(compiled);
  legacyWithSemanticVersion.scenes.forEach((scene) => { scene.template = "signal_lab_v1"; });
  delete legacyWithSemanticVersion.content.semantic;
  assert.throws(() => validateSemanticNarrative(legacyWithSemanticVersion), { code: "ANIMATION_SEMANTIC_INVALID" });
});

test("semantic renderer exposes five story stages, one persistent matched signal, and no editorial pipeline labels", async () => {
  const value = productionFixture();
  const ir = compileProductionAnimation({ draft: value.draft, timingContext: value.timingContext, projectId: value.projectId, projectRevision: 1, renderProfile: "preview" }).animationIR;
  const { compileAnimationIRToHtml } = await import("../renderer/hyperframes/animation-ir-adapter.mjs");
  const { persistentSignalGeometry, persistentSignalPath } = await import("../renderer/hyperframes/primitives/persistent-signal.mjs");
  const html = compileAnimationIRToHtml(ir).html;
  for (const id of ["stage-hook", "stage-context", "stage-evidence", "stage-turn", "stage-payoff"]) assert.match(html, new RegExp(`id="${id}"`));
  for (const cue of ["wow_annotation", "duration_72_seconds", "beam_signal_trace", "no_verified_repeat", "no_repeatable_proof"]) assert.match(html, new RegExp(`data-semantic-cue-id="${cue}"`));
  assert.equal((html.match(/id="signal-evidence"/g) || []).length, 1);
  assert.match(html, /id="signal-evidence"[^>]+data-persistent-entity="true"/);
  assert.match(html, /id="signal-evidence-path"/);
  assert.match(html, /id="signal-evidence-marker" data-follow-path-id="signal-evidence-path"/);
  assert.match(html, new RegExp(`id="signal-evidence-path" d="${persistentSignalPath(persistentSignalGeometry("observation_spike_v1")).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(html, /interpolatePersistent/);
  assert.doesNotMatch(html, /id="(?:evidence-carry-morph|single-signal-spike|frequency-cursor-dot|signal-response-dot|signal-trace-dot)"/);
  assert.match(html, /id="beam-cause-panel"/);
  assert.match(html, /id="signal-response-panel"/);
  assert.match(html, /id="signal-trace-clip-rect"/);
  assert.match(html, /id="beam-profile-clip-rect"/);
  assert.match(html, /id="beam-reference"[^>]+clip-path="url\(#beam-profile-clip\)"/);
  assert.doesNotMatch(html, /id="beam-reference"[^>]+stroke-dashoffset/);
  assert.match(html, /id="beam-profile-dot"/);
  assert.doesNotMatch(html, /Math\.exp/);
  assert.match(html, /const cueReveal=\(frame,key\)/);
  assert.match(html, /frame-op\.startFrame/);
  assert.doesNotMatch(html, /op\.startFrame-preRoll/);
  assert.match(html, /stage\.startFrame\)\/10/);
  assert.match(html, /frame>=stage\.holdStartFrame&&frame<stage\.holdEndFrame\)return 1/);
  assert.match(html, /stage\.endFrame\+8-frame/);
  const changedYear = structuredClone(ir);
  changedYear.content.semantic.eventYearLabel = "1984";
  assert.match(compileAnimationIRToHtml(changedYear).html, /class="small-label"[^>]*>1984<\/text>/);
  assert.doesNotMatch(html, />\s*(?:HOOK|CONTEXT|EVIDENCE|TURN|PAYOFF)\s*</);
});

test("semantic explanatory geometry locks the frequency cue and every chart marker to one cubic source", async () => {
  const {
    SEMANTIC_BEAM_PROFILE,
    SEMANTIC_EVIDENCE_MORPH_SOURCE,
    semanticCubicPoint,
    semanticFrequencyCursorX,
  } = await import("../renderer/hyperframes/animation-ir-adapter.mjs");
  assert.equal(semanticFrequencyCursorX(0), 100);
  assert.equal(semanticFrequencyCursorX(0.62), 360);
  assert.equal(semanticFrequencyCursorX(1), 360);
  assert.ok(Array.from({ length: 101 }, (_, index) => semanticFrequencyCursorX(index / 100)).every((x) => x >= 100 && x <= 360));
  assert.throws(() => semanticFrequencyCursorX(Number.NaN), TypeError);

  for (const progress of [0, 0.125, 0.25, 0.5, 0.75, 0.875, 1]) {
    const beam = semanticCubicPoint(SEMANTIC_BEAM_PROFILE, progress);
    const response = semanticCubicPoint(SEMANTIC_EVIDENCE_MORPH_SOURCE, progress);
    assert.equal(beam.x, response.x);
    assert.ok(Math.abs(((455 - beam.y) / 155) - ((720 - response.y) / 160)) < 0.00001);
    assert.ok(response.x >= 120 && response.x <= 610);
    assert.ok(response.y >= 560 && response.y <= 720);
  }
  assert.deepEqual(semanticCubicPoint(SEMANTIC_EVIDENCE_MORPH_SOURCE, 0), { x: 120, y: 720 });
  assert.deepEqual(semanticCubicPoint(SEMANTIC_EVIDENCE_MORPH_SOURCE, 0.5), { x: 365, y: 560 });
  assert.deepEqual(semanticCubicPoint(SEMANTIC_EVIDENCE_MORPH_SOURCE, 1), { x: 610, y: 720 });
  assert.throws(() => semanticCubicPoint([0, 1], 0.5), TypeError);
});

test("browser seek sampling is bounded while retaining every scene midpoint", () => {
  const durationFrames = 1200;
  const scenes = Array.from({ length: 12 }, (_, sceneIndex) => {
    const startFrame = sceneIndex * 100;
    return {
      startFrame,
      endFrame: startFrame + 100,
      operations: Array.from({ length: 40 }, (_, operationIndex) => ({
        from: { resolvedFrame: startFrame + operationIndex },
        to: { resolvedFrame: startFrame + operationIndex + 2 },
      })),
    };
  });
  const sequence = safeSeekSequence({ durationFrames, profileVersion: "1.0.0", content: {}, scenes });
  assert.ok(sequence.length <= 55);
  for (const scene of scenes) assert.ok(sequence.includes(Math.floor((scene.startFrame + scene.endFrame - 1) / 2)));
});

test("action seek sampling retains the maximum signature and hold proof", () => {
  const scenes = Array.from({ length: 20 }, (_, index) => ({
    startFrame: index * 5,
    endFrame: index * 5 + 5,
    operations: [],
  }));
  const signatureCheckpoints = Array.from({ length: 20 }, (_, index) => ({
    signature: `signature_${index}`,
    frame: 10 + index,
  }));
  const settledHoldFrames = Array.from({ length: 20 }, (_, index) => 40 + index);
  const sequence = safeSeekSequence({
    durationFrames: 120,
    profileVersion: "1.3.0",
    content: {
      semantic: { profileId: "dark_curiosity_semantic_sentences_v3" },
    },
    scenes,
  }, {
    signatureCheckpoints,
    phaseFrames: [30, 31, 32, 33, 34],
    settledHoldFrames,
  });
  assert.ok(sequence.length <= 55);
  for (const checkpoint of signatureCheckpoints) {
    assert.ok(sequence.includes(checkpoint.frame));
  }
  for (const frame of settledHoldFrames) assert.ok(sequence.includes(frame));
});

test("browser policy requires complete bounded sentence geometry coverage", () => {
  const seekSequence = [0, 10, 0];
  const expected = {
    seekSequence,
    cacheWarmupFrames: [0],
    pathFollowerIds: [],
    persistentEntityIds: [],
    visualStateIds: ["sentence_a", "sentence_b"],
    focusIntervalIds: [],
    transitionIds: [],
    boundedGeometrySentenceIndices: [0, 1],
  };
  const valid = {
    seekSequence,
    cacheWarmupFrames: [0],
    captures: seekSequence.map((frame) => ({ frame, sha256: hash("a") })),
    repeatedFrames: [{ frame: 0, equal: true }],
    loadedOnce: true,
    pageLoadCount: 1,
    stateIsolation: { valid: true },
    externalRequestCount: 0,
    blockedExternalRequestCount: 0,
    geometryAudit: {
      passed: true,
      checkpointCount: seekSequence.length,
      persistentObservationCount: 0,
      pathFollowerObservationCount: 0,
      boundedGeometryObservationCount: 2,
      labelObservationCount: 2,
      markedLabelIds: ["sentence_label"],
      observedLabelIds: ["sentence_label"],
      unobservedLabelIds: [],
      observedPathFollowerIds: [],
      unobservedPathFollowerIds: [],
      observedBoundedGeometrySentenceIndices: [0, 1],
      unobservedBoundedGeometrySentenceIndices: [],
      persistentStateCoverage: {},
      observedTransitionIds: [],
      observedFocusIntervalIds: [],
      unobservedFocusIntervalIds: [],
      clippedEntities: [],
      captionSafeZoneViolations: [],
      pathFollowerViolations: [],
      semanticRouteViolations: [],
      boundedGeometryClippingViolations: [],
      boundedGeometryCaptionSafeZoneViolations: [],
      persistentContinuityViolations: [],
      focusViolations: [],
      primaryRoiViolations: [],
      legibilityViolations: [],
      contrastViolations: [],
    },
    passed: true,
  };
  assert.equal(browserResultMeetsPolicy(valid, expected), true);
  const missing = structuredClone(valid);
  missing.geometryAudit.boundedGeometryObservationCount = 0;
  missing.geometryAudit.observedBoundedGeometrySentenceIndices = [];
  missing.geometryAudit.unobservedBoundedGeometrySentenceIndices = [0, 1];
  assert.equal(browserResultMeetsPolicy(missing, expected), false);
  const partial = structuredClone(valid);
  partial.geometryAudit.observedBoundedGeometrySentenceIndices = [0];
  partial.geometryAudit.unobservedBoundedGeometrySentenceIndices = [1];
  assert.equal(browserResultMeetsPolicy(partial, expected), false);
});

test("production plan rejects unsupported formats and changes with content", () => {
  const value = productionFixture();
  const changed = structuredClone(value.draft);
  delete changed.contentHash;
  changed.script.title = "A different documented mystery";
  delete changed.script.contentHash;
  assert.throws(() => buildProductionAnimationPlan({ draft: { ...value.draft, brief: { ...value.draft.brief, formatId: "deepest_iceberg_layer_v1", contentHash: undefined }, contentHash: undefined }, timingContext: value.timingContext, projectId: value.projectId, projectRevision: 1 }), { code: "ANIMATION_TEMPLATE_INVALID" });
  assert.notEqual(normalizeDraftBundle(changed).contentHash, value.draft.contentHash);
});

test("production render service requires an alignment artifact binding", async () => {
  await assert.rejects(
    () => runProductionAnimationRender({
      projectId: `prj_${randomUUID()}`,
      jobId: `job_${randomUUID()}`,
      draftArtifactId: art("a"),
      draftHash: hash("a"),
      alignmentHash: hash("b"),
      stagingDir: tmpdir(),
      contentArtifactRepository: {},
    }),
    { code: "ANIMATION_RENDER_FAILED" },
  );
});

test("production render service persists hash-bound artifacts and blocks no QA gate", async () => {
  const value = productionFixture();
  const stagingDir = mkdtempSync(resolve(tmpdir(), "production-animation-"));
  const created = [];
  const contentArtifactRepository = { createJson(input) { const bodyHash = contentHash(input.body); const result = { artifact: { id: `art_${bodyHash.slice(0, 40)}` }, envelope: { contentHash: bodyHash } }; created.push({ ...input, ...result }); return result; } };
  const provider = {
    id: "hyperframes_local",
    doctor: async () => ({ ready: true, runtimeVersion: "0.7.55" }),
    validate: (animationIR) => ({ animationIR, budget: { computedCost: 42 } }),
    estimate: ({ animationIR }) => ({ frames: animationIR.durationFrames, durationSeconds: animationIR.durationFrames / 30, complexityCost: 42, estimatedMemoryMb: 300, expectedDurationSeconds: 20 }),
    render: async (request) => {
      renderRequest = request;
      const { validated, stagingDir: rendererDir } = request;
      const outputPath = resolve(rendererDir, "visual-master.mp4");
      writeFileSync(outputPath, "continuous-video");
      const { compileAnimationIRToHtml } = await import("../renderer/hyperframes/animation-ir-adapter.mjs");
      return { outputPath, outputSha256: require("node:crypto").createHash("sha256").update("continuous-video").digest("hex"), animationIRHash: validated.animationIR.contentHash, compositionHash: compileAnimationIRToHtml(validated.animationIR).compositionHash };
    },
    verify: (manifest) => ({ valid: true, outputSha256: manifest.outputSha256, animationIRHash: manifest.animationIRHash }),
  };
  let renderRequest;
  let browserRequest;
  let browserResult;
  const alignmentArtifactId = art("d");
  try {
    const result = await runProductionAnimationRender({ draft: value.draft, alignment: value.alignment, projectId: value.projectId, projectRevision: 1, jobId: `job_${randomUUID()}`, draftArtifactId: art("a"), draftHash: value.draft.contentHash, alignmentArtifactId, alignmentHash: value.alignment.contentHash, renderProfile: "preview", stagingDir, contentArtifactRepository }, {
      providerRegistry: { get: () => provider },
      chromePath: "/mock/chrome",
      runBrowserSeekProof: async (request) => {
        browserRequest = request;
        browserResult = {
          seekSequence: request.seekSequence,
          cacheWarmupFrames: request.cacheWarmupFrames,
          captures: request.seekSequence.map((frame, sequenceIndex) => ({
            sequenceIndex,
            frame,
            sha256: hash("b"),
          })),
          repeatedFrames: [{
            frame: 0,
            occurrences: 2,
            sha256: hash("b"),
            equal: true,
          }],
          loadedOnce: true,
          pageLoadCount: 1,
          stateIsolation: { valid: true },
          externalRequestCount: 0,
          blockedExternalRequestCount: 0,
          resourceClasses: [],
          geometryAudit: {
            passed: true,
            semanticRoi: request.expectedSemanticRoi,
            captionSafeZone: request.expectedCaptionSafeZone,
            checkpointCount: request.seekSequence.length,
            entityObservationCount: 10,
            pathFollowerObservationCount: 2,
            semanticRouteObservationCount: request.expectedSemanticRouteIds.length,
            observedSemanticRouteIds: request.expectedSemanticRouteIds,
            unobservedSemanticRouteIds: [],
            persistentObservationCount: 10,
            labelObservationCount: request.expectedLabelIds.length,
            markedLabelIds: request.expectedLabelIds,
            observedLabelIds: request.expectedLabelIds,
            unobservedLabelIds: [],
            observedPathFollowerIds: request.expectedPathFollowerIds,
            unobservedPathFollowerIds: [],
            persistentStateCoverage: {
              signal_evidence: request.expectedVisualStateIds,
            },
            observedTransitionIds: request.expectedTransitionIds,
            observedFocusIntervalIds: request.expectedFocusIntervalIds,
            unobservedFocusIntervalIds: [],
            clippedEntities: [],
            captionSafeZoneViolations: [],
            pathFollowerViolations: [],
            semanticRouteViolations: [],
            boundedGeometryClippingViolations: [],
            boundedGeometryCaptionSafeZoneViolations: [],
            persistentContinuityViolations: [],
            focusViolations: [],
            primaryRoiViolations: [],
            legibilityViolations: [],
            contrastViolations: [],
          },
          passed: true,
        };
        return browserResult;
      },
      runBenchmarkQa: (request) => ({ passed: true, checks: { immediateHook: true, consecutiveStasis: true, contiguousStasis: true, balancedMotion: true }, technical: { codec: "h264", pixelFormat: "yuv420p", width: 720, height: 1280, fps: 30, frameCount: 1031, durationSeconds: 1031 / 30 }, motion: { temporalMetricProfileId: "dark_curiosity_luma_temporal_motion_v1", temporalThresholdStatus: "provisional", ...mockMotionEvidence(request), decodedFrameSequenceHash: hash("e"), firstMeaningfulMotionFrame: 1, consecutiveStasisRatio: 0.1, maxContiguousStasisFrames: 10, maxWindowMotionShare: 0.3, rawMaxWindowMotionShare: 0.35, sampleHashes: [hash("c")] }, clippedEntities: 0, captionSafeZoneViolations: 0 }),
    });
    assert.deepEqual(created.map((entry) => entry.type), ["animation_timing_context", "animation_plan", "animation_ir", "animation_qa_report", "animation_render_manifest"]);
    assert.equal(result.manifest.provider, "hyperframes_local");
    assert.equal(result.manifest.animationIRHash, result.irArtifact.envelope.contentHash);
    assert.equal(result.manifest.visualMasterSha256, result.visualMasterSha256);
    assert.equal(result.manifest.animationQaHash, result.qaArtifact.envelope.contentHash);
    assert.equal(result.qa.draftArtifactId, art("a"));
    assert.equal(result.qa.draftHash, value.draft.contentHash);
    assert.equal(result.qa.alignmentArtifactId, alignmentArtifactId);
    assert.equal(result.qa.alignmentHash, value.alignment.contentHash);
    assert.equal(result.qa.timingContextArtifactId, result.timingArtifact.artifact.id);
    assert.equal(result.qa.animationPlanArtifactId, result.planArtifact.artifact.id);
    assert.equal(result.qa.animationIRArtifactId, result.irArtifact.artifact.id);
    assert.equal(result.qa.semanticProfileId, "wow_signal_case_v1");
    assert.equal(result.qa.renderProfile, "preview");
    assert.equal(result.qa.renderQuality, "standard");
    assert.equal(result.qa.motion.motion.decodedFrameSequenceHash, hash("e"));
    assert.equal(result.qa.motion.motion.analysisWidth, 180);
    assert.equal(result.qa.motion.motion.analysisHeight, 206);
    assert.equal(Object.hasOwn(result.qa.motion.motion, "sampleHashes"), false);
    assert.equal(result.manifest.draftArtifactId, art("a"));
    assert.equal(result.manifest.draftHash, value.draft.contentHash);
    assert.equal(result.manifest.alignmentArtifactId, alignmentArtifactId);
    assert.equal(result.manifest.alignmentHash, value.alignment.contentHash);
    assert.equal(result.manifest.semanticProfileId, "wow_signal_case_v1");
    assert.equal(result.manifest.renderProfile, "preview");
    assert.equal(result.manifest.renderQuality, "standard");
    assert.deepEqual(created[3].dependencyHashes, [
      value.draft.contentHash,
      value.alignment.contentHash,
      result.timingArtifact.envelope.contentHash,
      result.planArtifact.envelope.contentHash,
      result.irArtifact.envelope.contentHash,
      result.visualMasterSha256,
      result.qa.browserProofHash,
      result.qa.motionProofHash,
    ]);
    assert.deepEqual(created[4].dependencyHashes, [
      value.draft.contentHash,
      value.alignment.contentHash,
      result.timingArtifact.envelope.contentHash,
      result.planArtifact.envelope.contentHash,
      result.irArtifact.envelope.contentHash,
      result.qaArtifact.envelope.contentHash,
      result.visualMasterSha256,
      result.qa.browserProofHash,
      result.qa.motionProofHash,
    ]);
    assert.equal(renderRequest.timeoutMs, 1200000);
    assert.equal(renderRequest.quality, "standard");
    assert.deepEqual(browserRequest.expectedPathFollowerIds, ["beam-profile-dot", "signal-evidence-marker"]);
    assert.deepEqual(browserRequest.expectedPersistentEntityIds, ["signal_evidence"]);
    assert.deepEqual(browserRequest.expectedVisualStateIds, result.animationIR.visualStateGraph.states.map((state) => state.id));
    assert.deepEqual(browserRequest.expectedFocusIntervalIds, result.animationIR.visualStateGraph.focusIntervals.map((interval) => interval.id));
    assert.deepEqual(browserRequest.expectedTransitionIds, result.animationIR.visualStateGraph.stateTransitions.map((transition) => transition.id));
    assert.equal(browserRequest.legibilityProfile, "mobile_720_v1");
    for (const interval of result.animationIR.visualStateGraph.focusIntervals) assert.ok(browserRequest.cacheWarmupFrames.includes(Math.floor((interval.startFrame + interval.endFrame - 1) / 2)));
    assert.equal(result.qa.browser.geometryAudit.persistentContinuityViolationCount, 0);
    assert.equal(result.qa.browser.geometryAudit.focusViolationCount, 0);
    assert.equal(result.qa.browser.geometryAudit.legibilityViolationCount, 0);
    assert.equal(result.qa.browser.geometryAudit.contrastViolationCount, 0);
    assert.equal(result.qa.browser.geometryAudit.semanticRouteViolationCount, 0);
    assert.equal(result.qa.browser.geometryAudit.boundedGeometryObservationCount, 0);
    assert.deepEqual(result.qa.browser.geometryAudit.observedBoundedGeometrySentenceIndices, []);
    assert.equal(result.qa.browser.geometryAudit.unobservedBoundedGeometrySentenceCount, 0);
    assert.equal(result.qa.browser.geometryAudit.boundedGeometryClippingViolationCount, 0);
    assert.equal(result.qa.browser.geometryAudit.boundedGeometryCaptionSafeZoneViolationCount, 0);
    assert.deepEqual(result.qa.browser.cacheWarmupFrames, browserRequest.cacheWarmupFrames);
    assert.deepEqual(
      result.qa.browser.geometryAudit.markedLabelIds,
      browserRequest.expectedLabelIds,
    );
    assert.deepEqual(
      result.qa.browser.geometryAudit.observedLabelIds,
      browserRequest.expectedLabelIds,
    );
    assert.equal(result.qa.browser.geometryAudit.unobservedLabelCount, 0);
    assert.equal(result.qa.browserProofHash, contentHash(result.qa.browser));
    const expectedBrowserPolicy = {
      seekSequence: browserRequest.seekSequence,
      cacheWarmupFrames: browserRequest.cacheWarmupFrames,
      pathFollowerIds: browserRequest.expectedPathFollowerIds,
      persistentEntityIds: browserRequest.expectedPersistentEntityIds,
      visualStateIds: browserRequest.expectedVisualStateIds,
      focusIntervalIds: browserRequest.expectedFocusIntervalIds,
      transitionIds: browserRequest.expectedTransitionIds,
      semanticRouteIds: browserRequest.expectedSemanticRouteIds,
      labelIds: browserRequest.expectedLabelIds,
      semanticRoi: browserRequest.expectedSemanticRoi,
      captionSafeZone: browserRequest.expectedCaptionSafeZone,
    };
    assert.equal(browserResultMeetsPolicy(browserResult, expectedBrowserPolicy), true);
    const reorderedWarmup = structuredClone(browserResult);
    reorderedWarmup.cacheWarmupFrames.reverse();
    assert.equal(browserResultMeetsPolicy(reorderedWarmup, expectedBrowserPolicy), false);
    const missingLabelProof = structuredClone(browserResult);
    delete missingLabelProof.geometryAudit.markedLabelIds;
    assert.equal(browserResultMeetsPolicy(missingLabelProof, expectedBrowserPolicy), false);
    const hiddenMarkedLabel = structuredClone(browserResult);
    hiddenMarkedLabel.geometryAudit.observedLabelIds = [];
    hiddenMarkedLabel.geometryAudit.unobservedLabelIds = [
      browserRequest.expectedLabelIds[0],
    ];
    assert.equal(browserResultMeetsPolicy(hiddenMarkedLabel, expectedBrowserPolicy), false);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
});
