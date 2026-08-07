"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");

const {
  normalizeAnimationTimingContext,
} = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");
const {
  normalizeVisualProgramProposalV2,
  normalizeVisualProgramV2,
  visualProgramV2ContentHash,
} = require("../server/pipelines/narrated-short/animation/visual-program-v2-contract.cjs");
const {
  calibrationSemanticGraphContentHashV2,
  compileGeneralizedVisualProgramV2,
} = require("../server/pipelines/narrated-short/animation/visual-program-v2-compiler.cjs");

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const draftHash = sha("v2-draft");
  const timingContext = normalizeAnimationTimingContext({
    schemaVersion: 1,
    fps: 30,
    durationFrames: 240,
    alignmentHash: sha("v2-alignment"),
    draftHash,
    words: [
      ["A", 0, 18], ["signal", 20, 38], ["reaches", 40, 58], ["software", 60, 80],
      ["Software", 100, 118], ["shows", 120, 138], ["wrong", 140, 158], ["output", 160, 180],
    ].map(([text, startFrame, endFrame], index) => ({ index, text, startFrame, endFrame })),
    beats: [
      { beatId: "beat_alpha", wordStartIndex: 0, wordEndIndex: 4, startFrame: 0, endFrame: 80 },
      { beatId: "beat_beta", wordStartIndex: 4, wordEndIndex: 8, startFrame: 100, endFrame: 180 },
    ],
  });
  const semanticEventGraph = {
    storyTitle: "WHY THE RECEIVER SHOWS THE WRONG DATE",
    draftHash,
    sourceStoryboardHash: sha("v2-storyboard"),
    timingContextHash: timingContext.contentHash,
    entities: [
      { id: "source_signal", kind: "navigation_signal", visualSubjectKind: "signal", label: "signal", persistent: false, claimIds: ["claim_alpha"] },
      { id: "receiver_software", kind: "software_interpreter", visualSubjectKind: "mapping", label: "software", persistent: true, claimIds: ["claim_alpha", "claim_beta"] },
      { id: "reported_output", kind: "device_output", visualSubjectKind: "date", label: "wrong output", persistent: false, claimIds: ["claim_beta"] },
    ],
    propositions: [
      {
        id: "prop_signal_route",
        beatId: "beat_alpha",
        eventKind: "causal_action",
        predicate: "routes_to",
        polarity: "affirmed",
        certainty: "verified",
        subject: { entityId: "source_signal" },
        object: { entityIds: ["receiver_software"] },
        visualAction: { operation: "send_signal", focusEntityIds: ["source_signal", "receiver_software"] },
        wordSpan: { startFrame: 0, endFrame: 80 },
      },
      {
        id: "prop_wrong_output",
        beatId: "beat_beta",
        eventKind: "state_transition",
        predicate: "maps_to_wrong_output",
        polarity: "affirmed",
        certainty: "verified",
        subject: { entityId: "receiver_software" },
        object: { entityIds: ["reported_output"] },
        visualAction: { operation: "show_wrong_output", focusEntityIds: ["receiver_software", "reported_output"] },
        wordSpan: { startFrame: 100, endFrame: 180 },
      },
    ],
  };
  const graphHash = calibrationSemanticGraphContentHashV2(semanticEventGraph);
  const proposal = {
    schemaVersion: 2,
    profile: "generalized_visual_program_proposal_v2",
    bindings: {
      semanticEventGraphHash: graphHash,
      timingContextHash: timingContext.contentHash,
      draftHash,
      sourceRevisionHash: semanticEventGraph.sourceStoryboardHash,
    },
    styleSpecId: "educational_line_art_reference_v1",
    scenes: [
      {
        id: "visual_signal_route",
        entityIds: ["source_signal", "receiver_software"],
        propositionIds: ["prop_signal_route"],
        layoutIntent: "directed_flow",
        focusEntityId: "receiver_software",
      },
      {
        id: "visual_wrong_output",
        entityIds: ["receiver_software", "reported_output"],
        propositionIds: ["prop_wrong_output"],
        layoutIntent: "split_compare",
        focusEntityId: "reported_output",
      },
    ],
  };
  return { timingContext, semanticEventGraph, proposal };
}

function compile(values = fixture()) {
  return compileGeneralizedVisualProgramV2({
    ...values,
    trustMode: "calibration_trusted",
  });
}

test("v2 compiles semantic entities and relations into deterministic engine-owned geometry and tracks", () => {
  const first = compile();
  const second = compile();
  assert.deepEqual(first, second);
  assert.equal(first.profile, "generalized_visual_program_v2");
  assert.deepEqual(first.trust, {
    mode: "calibration_trusted",
    disclosure: "operator_created_nonproduction",
  });
  assert.equal(first.presentation.title, "WHY THE RECEIVER SHOWS THE WRONG DATE");
  assert.deepEqual(first.scenes.map((scene) => scene.layoutIntent), ["directed_flow", "split_compare"]);
  assert.equal(first.scenes[0].entities[1].label, "software");
  assert.equal(first.scenes[0].relations[0].predicate, "routes_to");
  assert.ok(first.scenes.every((scene) => scene.layout.nodes.every((node) => (
    node.bounds.x >= 72 && node.bounds.y >= 276
      && node.bounds.x + node.bounds.width <= 1008
      && node.bounds.y + node.bounds.height <= 1344
  ))));
  assert.ok(first.scenes.every((scene) => scene.tracks.every((track) => (
    track.endFrame <= scene.readabilityHold.startFrame
  ))));
  assert.notEqual(first.scenes[0].compositionFingerprint, first.scenes[1].compositionFingerprint);
  assert.equal(normalizeVisualProgramV2(first).contentHash, first.contentHash);
});

test("v2 proposal is data-only and rejects display copy, geometry, timing, and executable fields", () => {
  const { proposal } = fixture();
  assert.equal(normalizeVisualProgramProposalV2(proposal).profile, "generalized_visual_program_proposal_v2");
  for (const mutate of [
    (value) => { value.scenes[0].label = "invented copy"; },
    (value) => { value.scenes[0].x = 12; },
    (value) => { value.scenes[0].startFrame = 0; },
    (value) => { value.scenes[0].purpose = "arbitrary prose"; },
    (value) => { value.scenes[0].code = "require('node:fs')"; },
  ]) {
    const candidate = structuredClone(proposal);
    mutate(candidate);
    assert.throws(() => normalizeVisualProgramProposalV2(candidate), (error) => (
      error?.code === "GENERALIZED_VISUAL_PROGRAM_V2_INVALID"
    ));
  }
});

test("v2 compiler rejects graph rebinding, reordered propositions, missing participants, and production use", () => {
  const values = fixture();
  const stale = structuredClone(values);
  stale.proposal.bindings.semanticEventGraphHash = "0".repeat(64);
  assert.throws(() => compile(stale));

  const reordered = fixture();
  reordered.proposal.scenes.reverse();
  assert.throws(() => compile(reordered));

  const missing = fixture();
  missing.proposal.scenes[0].entityIds = ["receiver_software"];
  assert.throws(() => compile(missing));

  assert.throws(() => compileGeneralizedVisualProgramV2({
    ...fixture(),
    trustMode: "production",
  }));
});

test("freshly rehashed compiled layout or trusted copy tampering still fails closed", () => {
  const output = structuredClone(compile());
  output.scenes[0].layout.nodes[0].bounds.x = 0;
  output.contentHash = visualProgramV2ContentHash(output);
  assert.throws(() => normalizeVisualProgramV2(output));

  const copyTamper = structuredClone(compile());
  copyTamper.scenes[0].entities[0].label = "https://remote.invalid";
  copyTamper.contentHash = visualProgramV2ContentHash(copyTamper);
  assert.throws(() => normalizeVisualProgramV2(copyTamper));
});
