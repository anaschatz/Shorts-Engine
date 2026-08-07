"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const RUNNER_URL = new URL("../tools/render-generalized-visual-v2-video-proof.mjs", `file://${__filename}`);

async function runner() {
  return import(RUNNER_URL.href);
}

function allKeys(value, output = []) {
  if (!value || typeof value !== "object") return output;
  for (const [key, entry] of Object.entries(value)) {
    output.push(key.toLowerCase());
    allKeys(entry, output);
  }
  return output;
}

test("v2 video proof CLI is write-gated, planner-explicit, and bounded to three stories", async () => {
  const module = await runner();
  assert.deepEqual(module.GENERALIZED_VISUAL_V2_PROOF_STORY_IDS, ["gps", "odometer", "baychimo"]);
  assert.deepEqual(module.parseGeneralizedVisualV2ProofArguments([]), {
    story: "all",
    storyIds: ["gps", "odometer", "baychimo"],
    confirmWrite: false,
    dryRun: true,
    plannerMode: "auto",
    requireLivePlanner: false,
  });
  assert.deepEqual(module.parseGeneralizedVisualV2ProofArguments([
    "--story", "baychimo", "--planner-mode", "operator", "--confirm-write",
  ]), {
    story: "baychimo",
    storyIds: ["baychimo"],
    confirmWrite: true,
    dryRun: false,
    plannerMode: "operator",
    requireLivePlanner: false,
  });
  assert.deepEqual(module.parseGeneralizedVisualV2ProofArguments([
    "--story", "gps", "--require-live-planner",
  ]), {
    story: "gps",
    storyIds: ["gps"],
    confirmWrite: false,
    dryRun: true,
    plannerMode: "live",
    requireLivePlanner: true,
  });
  assert.throws(() => module.parseGeneralizedVisualV2ProofArguments(["--story", "unknown"]));
  assert.throws(() => module.parseGeneralizedVisualV2ProofArguments(["--planner-mode", "unbounded"]));
  assert.throws(() => module.parseGeneralizedVisualV2ProofArguments([
    "--planner-mode", "operator", "--require-live-planner",
  ]));
  assert.throws(() => module.parseGeneralizedVisualV2ProofArguments(["--dry-run", "--confirm-write"]));
  await assert.rejects(() => module.renderGeneralizedVisualV2Proof({
    storyIds: ["gps"],
    dryRun: true,
    plannerMode: "operator",
    requireLivePlanner: true,
  }));
});

test("GPS, odometer, and Baychimo use one compiler and style but distinct semantic compositions", async () => {
  const module = await runner();
  const gps = module.compileGeneralizedVisualV2ProofStory("gps");
  const odometer = module.compileGeneralizedVisualV2ProofStory("odometer");
  const baychimo = module.compileGeneralizedVisualV2ProofStory("baychimo");

  assert.equal(gps.plan.profile, "generalized_visual_program_v2");
  assert.equal(odometer.plan.profile, "generalized_visual_program_v2");
  assert.equal(baychimo.plan.profile, "generalized_visual_program_v2");
  assert.deepEqual(gps.plan.style, odometer.plan.style);
  assert.deepEqual(gps.plan.style, baychimo.plan.style);
  assert.equal(gps.composition.style.contentHash, odometer.composition.style.contentHash);
  assert.equal(gps.composition.style.contentHash, baychimo.composition.style.contentHash);
  assert.notEqual(gps.plan.contentHash, odometer.plan.contentHash);
  assert.notEqual(gps.plan.contentHash, baychimo.plan.contentHash);
  assert.notEqual(odometer.plan.contentHash, baychimo.plan.contentHash);
  assert.notEqual(gps.composition.compositionHash, odometer.composition.compositionHash);
  assert.notEqual(gps.composition.compositionHash, baychimo.composition.compositionHash);
  assert.equal(gps.plan.presentation.title, "WHY A GPS DATE JUMPED BACK");
  assert.equal(odometer.plan.presentation.title, "WHY AN ODOMETER RETURNS TO ZERO");
  assert.equal(baychimo.plan.presentation.title, "THE SHIP THE ARCTIC WOULD NOT KEEP");
  assert.equal(gps.plan.duration.totalFrames, 899);
  assert.equal(odometer.plan.duration.totalFrames, 537);
  assert.equal(baychimo.plan.duration.totalFrames, 1068);
  assert.equal(baychimo.plan.scenes.length, 6);
  assert.equal(baychimo.sourceProvenance.profile, "semantic_event_graph_v3_to_visual_program_v2");
  assert.equal(baychimo.sourceProvenance.v2GraphHandAuthored, false);
  assert.equal(baychimo.sourceProvenance.sourceGraphHash, "54383a235b65264c4c8e269d9fd49901de439c8c92e256963179393b87832ab4");
  assert.equal(baychimo.semanticEventGraph.propositions.length, 15);

  const bundles = [gps, odometer, baychimo];
  for (let left = 0; left < bundles.length; left += 1) {
    for (let right = left + 1; right < bundles.length; right += 1) {
      const leftFingerprints = new Set(bundles[left].plan.scenes.map((scene) => scene.compositionFingerprint));
      const rightFingerprints = new Set(bundles[right].plan.scenes.map((scene) => scene.compositionFingerprint));
      assert.deepEqual([...leftFingerprints].filter((entry) => rightFingerprints.has(entry)), []);
    }
  }
  assert.match(gps.composition.html, /data-primitive="satellite"/);
  assert.match(gps.composition.html, /data-primitive="receiver"/);
  assert.match(gps.composition.html, /data-primitive="calendar"/);
  assert.match(odometer.composition.html, /data-primitive="vehicle"/);
  assert.match(odometer.composition.html, /data-primitive="wheel_bank"/);
  assert.match(odometer.composition.html, /"operation":"propagate_carry"/);
});

test("timeline layouts clamp ordinary and compound nodes inside the visual ROI", async () => {
  const module = await runner();
  const {
    buildVisualProgramV2PlannerContext,
    materializeVisualProgramProposalV2,
    normalizeVisualProgramV2PlannerChoice,
  } = require("../server/pipelines/narrated-short/animation/visual-program-v2-planner-contract.cjs");
  const {
    compileGeneralizedVisualProgramV2,
  } = require("../server/pipelines/narrated-short/animation/visual-program-v2-compiler.cjs");
  const timingContext = module.buildGeneralizedVisualV2ProofTimingContext("odometer");
  const semanticEventGraph = module.buildGeneralizedVisualV2ProofSemanticGraph(
    "odometer",
    timingContext,
  );
  const context = buildVisualProgramV2PlannerContext({
    semanticEventGraph,
    timingContext,
  });
  const choice = normalizeVisualProgramV2PlannerChoice({
    schemaVersion: 1,
    scenes: [
      {
        startPropositionIndex: 0,
        endPropositionIndexExclusive: 4,
        layoutIntent: "directed_flow",
        focusEntityIndex: 1,
      },
      {
        startPropositionIndex: 4,
        endPropositionIndexExclusive: 5,
        layoutIntent: "timeline_track",
        focusEntityIndex: 5,
      },
      {
        startPropositionIndex: 5,
        endPropositionIndexExclusive: 8,
        layoutIntent: "radial_focus",
        focusEntityIndex: 0,
      },
    ],
  }, context);
  const proposal = structuredClone(
    materializeVisualProgramProposalV2(context, choice),
  );
  delete proposal.contentHash;
  const program = compileGeneralizedVisualProgramV2({
    semanticEventGraph,
    timingContext,
    proposal,
    proposalSource: "local_llm",
    trustMode: "calibration_trusted",
  });
  for (const scene of program.scenes) {
    const roi = scene.layout.regions.visualRoi;
    for (const node of scene.layout.nodes) {
      assert.equal(node.bounds.x >= roi.x, true);
      assert.equal(node.bounds.x + node.bounds.width <= roi.x + roi.width, true);
      assert.equal(node.bounds.y >= roi.y, true);
      assert.equal(node.bounds.y + node.bounds.height <= roi.y + roi.height, true);
    }
  }
});

test("Baychimo is built from the checked v3 graph and exact aligned local evidence", async () => {
  const module = await runner();
  const bundle = module.compileGeneralizedVisualV2ProofStory("baychimo");
  const words = bundle.timingContext.words;
  assert.equal(words.length, 89);
  assert.equal(words.at(-1).endFrame, 1031);
  assert.equal(bundle.timingContext.durationFrames - words.at(-1).endFrame, 37);
  assert.equal(bundle.timingContext.alignmentHash, "ff4dd9547d563f396aff90234faaf28eafcf10bb003b7b7a82717b8617d3ccc0");
  assert.deepEqual(bundle.plan.scenes.map((scene) => [scene.startFrame, scene.endFrame]), [
    [0, 199], [199, 388], [388, 453], [453, 616], [616, 818], [818, 1068],
  ]);
  const sources = module.verifyGeneralizedVisualV2ProofSourceArtifacts(bundle);
  assert.equal(sources.sourceVideoHash, "b011445f5b69f9ddd022e1b05adcb02362b9d782c4db9c13d88eccccfe775da5");
  assert.equal(sources.rightsConfirmed, true);
  assert.equal(sources.publishApprovalRequired, true);
  assert.equal(sources.alignmentHash, bundle.timingContext.alignmentHash);
});

test("proof proposals contain only bounded semantic selections", async () => {
  const module = await runner();
  const forbidden = new Set([
    "anchor", "code", "css", "endframe", "frame", "height", "html", "label",
    "markup", "path", "purpose", "script", "startframe", "svg", "text", "transform",
    "triggerframe", "url", "viewbox", "width", "x", "y",
  ]);
  for (const storyId of module.GENERALIZED_VISUAL_V2_PROOF_STORY_IDS) {
    const bundle = module.compileGeneralizedVisualV2ProofStory(storyId);
    const keys = allKeys(bundle.proposal);
    assert.deepEqual(keys.filter((key) => forbidden.has(key)), []);
    assert.equal(JSON.stringify(bundle.proposal).match(/https?:\/\//g), null);
    assert.deepEqual(bundle.plan.trust, {
      mode: "calibration_trusted",
      disclosure: "operator_created_nonproduction",
    });
  }
});

test("dry-run compiles evidence without mutating publishability or claiming human review", async () => {
  const module = await runner();
  const result = await module.renderGeneralizedVisualV2Proof({
    storyIds: ["gps", "odometer", "baychimo"],
    confirmWrite: false,
    dryRun: true,
    plannerMode: "operator",
  });
  assert.equal(result.mode, "dry_run");
  assert.equal(result.publishable, false);
  assert.equal(result.plannerMode, "operator");
  assert.equal(result.stories.length, 3);
  for (const report of result.stories) {
    assert.equal(report.publishable, false);
    assert.equal(report.humanReviewStatus, "pending");
    assert.equal(report.humanApproved, false);
    assert.equal(report.productionReady, false);
    assert.equal(report.rights.publishApprovalRequired, true);
    assert.ok([
      "calibration_only_not_commercially_attested",
      "internal_rights_confirmed_publish_approval_required",
    ].includes(report.rights.status));
    assert.equal(report.planner.mode, "operator");
    assert.equal(report.gates.technical, "not_run");
  }
});

test("auto planner mode records deterministic fallback provenance when the local provider is disabled", async () => {
  const module = await runner();
  const result = await module.renderGeneralizedVisualV2Proof({
    storyIds: ["gps", "odometer", "baychimo"],
    confirmWrite: false,
    dryRun: true,
    plannerMode: "auto",
    env: {
      SHORTSENGINE_LOCAL_LLM_VISUAL_PROGRAM_V2_MODE: "disabled",
    },
  });
  assert.equal(result.repetition.passed, true);
  assert.equal(result.stories.length, 3);
  for (const report of result.stories) {
    assert.equal(report.planner.plannerId, "local_llm_visual_program_v2_planner");
    assert.equal(report.planner.mode, "disabled");
    assert.equal(report.planner.providerId, "deterministic_fallback");
    assert.equal(report.planner.fallbackUsed, true);
    assert.equal(report.planner.failure.code, "ANIMATION_LOCAL_LLM_DISABLED");
    assert.equal(report.gates.semanticComposition, "passed");
  }
});

test("planner-backed dry-run records accepted provider provenance and live-required rejects mock output", async () => {
  const module = await runner();
  const {
    createLocalLlmVisualProgramV2Planner,
  } = require("../server/pipelines/narrated-short/animation/providers/local-llm-visual-program-v2-planner.cjs");
  const planner = createLocalLlmVisualProgramV2Planner({
    mode: "mock",
    modelId: "bounded-test-model",
  });
  const result = await module.renderGeneralizedVisualV2Proof({
    storyIds: ["gps", "odometer", "baychimo"],
    confirmWrite: false,
    dryRun: true,
    plannerMode: "auto",
    planner,
  });
  assert.equal(result.repetition.passed, true);
  const planned = await module.planGeneralizedVisualV2ProofStory("gps", {
    plannerMode: "auto",
    planner,
  });
  assert.equal(Object.isFrozen(planned.plannerChoice), true);
  assert.equal(
    planned.plannerChoice.contentHash,
    planned.plannerProvenance.choiceHash,
  );
  assert.equal(
    module.validateGeneralizedVisualV2PlannerChoiceArtifact(planned),
    planned.plannerChoice,
  );
  assert.throws(() => module.validateGeneralizedVisualV2PlannerChoiceArtifact({
    ...planned,
    plannerProvenance: {
      ...planned.plannerProvenance,
      choiceHash: "0".repeat(64),
    },
  }), /not hash-bound/);
  for (const report of result.stories) {
    assert.equal(report.planner.providerId, "deterministic_mock");
    assert.equal(report.planner.modelId, "deterministic-mock-v1");
    assert.equal(report.planner.fallbackUsed, false);
    assert.equal(report.planner.failure, null);
  }

  const baseline = module.compileGeneralizedVisualV2ProofStory("gps");
  await assert.rejects(() => module.planGeneralizedVisualV2ProofStory("baychimo", {
    plannerMode: "live",
    requireLivePlanner: true,
    planner,
    baselinePrograms: [{ storyId: "gps", program: baseline.plan }],
  }), /did not produce a live local-LLM planner result/);
});

test("comparison report scans every story pair and fails closed for any overlap", async () => {
  const module = await runner();
  const dryRun = await module.renderGeneralizedVisualV2Proof({
    storyIds: ["gps", "odometer", "baychimo"],
    confirmWrite: false,
    dryRun: true,
    plannerMode: "operator",
  });
  const results = dryRun.stories.map((report) => ({ storyId: report.storyId, report }));
  const comparison = module.buildGeneralizedVisualV2ComparisonReport(results, dryRun.repetition);
  assert.equal(comparison.schemaVersion, 2);
  assert.equal(comparison.publishable, false);
  assert.equal(comparison.humanReviewStatus, "pending");
  assert.equal(comparison.humanApproved, false);
  assert.equal(comparison.productionReady, false);
  assert.equal(comparison.pairwiseComparisons.length, 3);
  assert.equal(comparison.crossStorySceneFingerprintOverlap.length, 0);
  assert.equal(comparison.passed, true);

  const overlapping = structuredClone(results);
  overlapping[2].report.fingerprints.scenes[0].fingerprint =
    overlapping[0].report.fingerprints.scenes[0].fingerprint;
  const rejected = module.buildGeneralizedVisualV2ComparisonReport(overlapping, dryRun.repetition);
  assert.equal(rejected.crossStorySceneFingerprintOverlap.length, 1);
  assert.equal(rejected.passed, false);
  assert.throws(() => module.buildGeneralizedVisualV2ComparisonReport(results.slice(0, 1), dryRun.repetition));
});
