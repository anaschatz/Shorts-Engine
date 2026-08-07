import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
  compileGeneralizedVisualCompositionPlanV2ToHtml,
} from "../renderer/hyperframes/generalized-visual-composition-v2.mjs";
import {
  listGeneralizedVisualEntityPrimitivesV2,
} from "../renderer/hyperframes/generalized-visual-primitives-v2.mjs";
import {
  createGeneralizedVisualRuntimeDataV2,
  resolveGeneralizedVisualFrameStateV2,
} from "../renderer/hyperframes/generalized-visual-runtime-v2.mjs";

const require = createRequire(import.meta.url);
const {
  visualProgramV2ContentHash,
} = require("../server/pipelines/narrated-short/animation/visual-program-v2-contract.cjs");

function fixture() {
  const base = {
    schemaVersion: 2,
    profile: "generalized_visual_program_v2",
    profileVersion: "2.0.0",
    bindings: {
      proposalHash: "a".repeat(64),
      semanticEventGraphHash: "b".repeat(64),
      timingContextHash: "c".repeat(64),
      draftHash: "d".repeat(64),
      sourceRevisionHash: "e".repeat(64),
    },
    presentation: { title: "WHY THE SIGNAL LOOKS WRONG" },
    style: { specId: "educational_line_art_reference_v1", specVersion: "1.0.0" },
    trust: { mode: "calibration_trusted", disclosure: "operator_created_nonproduction" },
    duration: { fps: 30, totalFrames: 90 },
    scenes: [{
      id: "scene_one",
      entityIds: ["entity_scientist", "entity_signal"],
      propositionIds: ["proposition_one"],
      layoutIntent: "directed_flow",
      focusEntityId: "entity_scientist",
      startFrame: 0,
      endFrame: 90,
      readabilityHold: { startFrame: 82, endFrame: 90 },
      entities: [
        { id: "entity_scientist", kind: "person", visualSubjectKind: "observer", label: "The scientist", persistent: true, claimIds: ["claim_one"] },
        { id: "entity_signal", kind: "signal", visualSubjectKind: "unknown_signal_kind", label: "The signal", persistent: false, claimIds: ["claim_one"] },
      ],
      relations: [{ id: "relation_one", propositionId: "proposition_one", fromEntityId: "entity_signal", toEntityId: "entity_scientist", predicate: "transmits_to", polarity: "affirmed", certainty: "verified", order: 0 }],
      events: [{ id: "event_one", propositionId: "proposition_one", beatId: "beat_one", eventKind: "observation_action", predicate: "transmits_to", semanticOperation: "connect_entities", subjectEntityId: "entity_signal", objectEntityIds: ["entity_scientist"], focusEntityIds: ["entity_scientist"], certainty: "verified", startFrame: 0, endFrame: 40, order: 0 }],
      layout: {
        profileId: "deterministic_semantic_graph_layout_v2",
        profileVersion: "2.0.0",
        canvas: { width: 1080, height: 1920 },
        regions: { visualRoi: { x: 72, y: 276, width: 936, height: 1068 }, captionLane: { x: 0, y: 1416, width: 1080, height: 504 } },
        nodes: [
          { entityId: "entity_scientist", order: 0, role: "focus", bounds: { x: 220, y: 540, width: 204, height: 260 } },
          { entityId: "entity_signal", order: 1, role: "participant", bounds: { x: 660, y: 570, width: 204, height: 132 } },
        ],
        edges: [{ relationId: "relation_one", fromEntityId: "entity_signal", toEntityId: "entity_scientist", kind: "line", points: [{ x: 762, y: 636 }, { x: 322, y: 670 }] }],
        constraints: { maximumSimultaneousMotion: 2, minimumSettledHoldFrames: 8 },
      },
      tracks: [
        { id: "track_draw", targetKind: "relation", targetId: "relation_one", operation: "draw", startFrame: 0, endFrame: 20, easing: "ease_out_cubic", order: 0 },
        { id: "track_focus", targetKind: "entity", targetId: "entity_scientist", operation: "focus", startFrame: 20, endFrame: 40, easing: "ease_out_cubic", order: 1 },
      ],
      compositionFingerprint: "f".repeat(64),
    }],
  };
  return { ...base, contentHash: visualProgramV2ContentHash(base) };
}

test("v2 renderer composes a grounded semantic graph with one locked style", () => {
  const plan = fixture();
  const first = compileGeneralizedVisualCompositionPlanV2ToHtml(plan);
  const second = compileGeneralizedVisualCompositionPlanV2ToHtml(plan);
  assert.equal(first.renderer.profile, "generalized_visual_composition_renderer_v2");
  assert.equal(first.style.palette.background, "#030303");
  assert.equal(first.compositionHash, second.compositionHash);
  assert.match(first.html, /data-primitive="human_observer"/);
  assert.match(first.html, /data-primitive="signal_wave"/);
  assert.match(first.html, /data-primitive="dashed_signal"/);
  assert.match(first.html, /data-semantic-rejection-indicator="true"/);
  assert.match(first.html, /data-semantic-uncertainty-indicator="true"/);
  assert.match(first.html, /window\.__renderFrame=renderFrame/);
  assert.match(first.html, /window\.__timelines\[DATA\.compositionId\]/);
  assert.match(first.html, /data-caption-safe-zone="true"[^>]*fill="none"|fill="none"[^>]*data-caption-safe-zone="true"/);
  assert.deepEqual(
    ["steamship", "ice_field", "weather_front", "hypothesis", "unknown_outcome", "wheel_bank"]
      .filter((primitive) => !listGeneralizedVisualEntityPrimitivesV2().includes(primitive)),
    [],
  );
});

test("v2 runtime resolves persistent semantic-state operations deterministically", () => {
  const cases = [
    ["occlude_to_absent", "absenceProgress"],
    ["supersede_hypothesis", "supersedeProgress"],
    ["co_move", "coMoveProgress"],
    ["mark_last_known", "markProgress"],
    ["reject_hypothesis", "rejectionProgress"],
    ["unresolved_boundary", "unresolvedProgress"],
    ["empty_occupancy", "emptyProgress"],
    ["propagate_carry", "carryProgress"],
  ];
  for (const [operation, field] of cases) {
    const plan = structuredClone(fixture());
    plan.scenes[0].tracks = [{
      id: `track_${operation}`,
      targetKind: "entity",
      targetId: "entity_scientist",
      operation,
      startFrame: 0,
      endFrame: 20,
      easing: "ease_out_cubic",
      order: 0,
    }];
    plan.contentHash = visualProgramV2ContentHash(plan);
    const runtime = createGeneralizedVisualRuntimeDataV2(plan);
    const active = resolveGeneralizedVisualFrameStateV2(runtime, 10)
      .targetStates.find((target) => target.targetId === "entity_scientist");
    const settled = resolveGeneralizedVisualFrameStateV2(runtime, 30)
      .targetStates.find((target) => target.targetId === "entity_scientist");
    assert.ok(active[field] > 0 && active[field] < 1, `${operation} active progress`);
    assert.equal(settled[field], 1, `${operation} final progress`);
  }
});

test("v2 runtime resolves motion against the intended target", () => {
  const runtime = createGeneralizedVisualRuntimeDataV2(fixture());
  const drawing = resolveGeneralizedVisualFrameStateV2(runtime, 10);
  const relation = drawing.targetStates.find((target) => target.targetId === "relation_one");
  const scientist = drawing.targetStates.find((target) => target.targetId === "entity_scientist");
  assert.equal(drawing.activeOperations[0], "draw:relation:relation_one");
  assert.ok(relation.drawProgress > 0 && relation.drawProgress < 1);
  assert.equal(scientist.drawProgress, 1);
  assert.equal(resolveGeneralizedVisualFrameStateV2(runtime, 10).stateHash, drawing.stateHash);
});

test("v2 runtime crossfades scene replacements for eight deterministic frames", () => {
  const emptyScene = (id, startFrame, endFrame) => ({
    id,
    startFrame,
    endFrame,
    targets: [],
    tracks: [],
    maximumSimultaneousMotion: 2,
  });
  const runtime = {
    durationFrames: 60,
    scenes: [emptyScene("scene_old", 0, 30), emptyScene("scene_new", 30, 60)],
  };
  const boundary = resolveGeneralizedVisualFrameStateV2(runtime, 30);
  const finalBlend = resolveGeneralizedVisualFrameStateV2(runtime, 37);
  const settled = resolveGeneralizedVisualFrameStateV2(runtime, 38);
  assert.equal(boundary.transition.active, true);
  assert.deepEqual(boundary.transition.sceneOpacities.map((entry) => entry.opacity), [1, 0]);
  assert.equal(finalBlend.transition.progress, 1);
  assert.equal(settled.transition.active, false);
});
