"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const {
  normalizeDraftBundle,
} = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  buildGeneralizedSemanticArtifacts,
} = require("../server/pipelines/narrated-short/animation/generalized-semantic-event-planner.cjs");
const {
  buildSemanticVisualSentencePlan,
} = require("../server/pipelines/narrated-short/animation/semantic-visual-sentence-planner.cjs");
const {
  SEMANTIC_ANIMATION_SCENE_PROPOSAL_SCHEMA_VERSION,
  buildSemanticAnimationSceneDsl,
  normalizeSemanticAnimationSceneDsl,
  normalizeSemanticAnimationSceneProposal,
  semanticAnimationSceneDslContentHash,
  validateSemanticAnimationSceneDslAgainstContext,
} = require("../server/pipelines/narrated-short/animation/semantic-animation-scene-dsl.cjs");
const {
  normalizeAnimationTimingContext,
} = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");

const ROOT = resolve(__dirname, "..");

function timingFor(draft) {
  let frame = 0;
  let wordIndex = 0;
  const words = [];
  const beats = [];
  for (const beat of draft.script.beats) {
    const wordStartIndex = wordIndex;
    for (const wordText of beat.spokenText.split(/\s+/).filter(Boolean)) {
      words.push({
        index: wordIndex,
        text: wordText,
        startFrame: frame,
        endFrame: frame + 6,
      });
      wordIndex += 1;
      frame += 8;
    }
    beats.push({
      beatId: beat.id,
      wordStartIndex,
      wordEndIndex: wordIndex,
      startFrame: words[wordStartIndex].startFrame,
      endFrame: words[wordIndex - 1].endFrame,
    });
    frame += 16;
  }
  return normalizeAnimationTimingContext({
    schemaVersion: 1,
    fps: 30,
    durationFrames: frame + 30,
    alignmentHash: createHash("sha256")
      .update(`scene-dsl:${draft.contentHash}`)
      .digest("hex"),
    draftHash: draft.contentHash,
    words,
    beats,
  });
}

function fixture(
  id = "001_wow_signal_mystery",
  selectSentence = (sentences) => sentences[0],
) {
  const draft = normalizeDraftBundle(JSON.parse(readFileSync(resolve(
    ROOT,
    "eval",
    "narrated",
    "dark-curiosity",
    "fixtures",
    `${id}.json`,
  ), "utf8")));
  const timingContext = timingFor(draft);
  const semantic = buildGeneralizedSemanticArtifacts({ draft, timingContext });
  const plan = buildSemanticVisualSentencePlan(semantic.semanticEventGraph);
  const sentence = selectSentence(plan.sentences);
  assert.ok(sentence, `a matching sentence is required for ${id}`);
  return {
    graph: semantic.semanticEventGraph,
    plan,
    sentence,
    context: {
      semanticEventGraphHash: semantic.semanticEventGraph.contentHash,
      semanticVisualSentencePlanHash: plan.contentHash,
      propositionId: sentence.propositionId,
      primitiveParameters: sentence.primitiveParameters,
      sceneComposition: sentence.sceneComposition,
    },
  };
}

function validProposal() {
  return {
    schemaVersion: SEMANTIC_ANIMATION_SCENE_PROPOSAL_SCHEMA_VERSION,
    actions: [
      {
        op: "highlight",
        target: "module_support_a",
        phase: "develop",
        preset: "pulse_once",
      },
      {
        op: "transform",
        target: "module_primary",
        phase: "resolve",
        preset: "semantic_transition",
      },
    ],
  };
}

function assertDeepFrozen(value, field = "sceneDsl", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true, `${field} must be frozen`);
  for (const [key, child] of Object.entries(value)) {
    assertDeepFrozen(child, `${field}.${key}`, seen);
  }
}

test("scene DSL is canonical, hashed, deeply frozen and grounded", () => {
  const value = fixture();
  const first = buildSemanticAnimationSceneDsl({
    ...value.context,
    proposal: validProposal(),
  });
  const second = buildSemanticAnimationSceneDsl({
    ...structuredClone(value.context),
    proposal: structuredClone(validProposal()),
  });

  assert.deepEqual(first, second);
  assert.equal(first.contentHash, semanticAnimationSceneDslContentHash(first));
  assert.deepEqual(
    validateSemanticAnimationSceneDslAgainstContext(first, value.context),
    first,
  );
  assert.deepEqual(first.actions.slice(0, 3).map((action) => action.target), [
    "module_primary",
    "module_support_a",
    "module_support_b",
  ]);
  assert.equal(first.computedCost, 9);
  assertDeepFrozen(first);
});

test("model proposal is reference-only and rejects server-owned or raw fields", () => {
  const rawField = validProposal();
  rawField.actions[0].svg = "<svg onload='alert(1)'>";
  assert.throws(
    () => normalizeSemanticAnimationSceneProposal(rawField),
    { code: "ANIMATION_SCENE_PROPOSAL_INVALID" },
  );

  const rootField = {
    ...validProposal(),
    javascript: "fetch('https://example.test')",
  };
  assert.throws(
    () => normalizeSemanticAnimationSceneProposal(rootField),
    { code: "ANIMATION_SCENE_PROPOSAL_INVALID" },
  );

  const create = validProposal();
  create.actions[0] = {
    op: "create",
    target: "module_support_a",
    phase: "entry",
    preset: "reveal",
  };
  assert.throws(
    () => normalizeSemanticAnimationSceneProposal(create),
    { code: "ANIMATION_SCENE_PROPOSAL_INVALID" },
  );
});

test("proposal budgets reject duplicate, excessive and ungrounded choreography", () => {
  const duplicate = validProposal();
  duplicate.actions.push(structuredClone(duplicate.actions[0]));
  assert.throws(
    () => normalizeSemanticAnimationSceneProposal(duplicate),
    (cause) => (
      cause?.code === "ANIMATION_SCENE_PROPOSAL_INVALID"
      && cause?.details?.reason === "duplicate_operation_target"
    ),
  );

  const excessive = {
    schemaVersion: 1,
    actions: [
      {
        op: "camera",
        target: "scene",
        phase: "develop",
        preset: "push_primary",
      },
      {
        op: "highlight",
        target: "module_support_a",
        phase: "develop",
        preset: "pulse_once",
      },
      {
        op: "highlight",
        target: "module_support_b",
        phase: "resolve",
        preset: "pulse_once",
      },
      {
        op: "transform",
        target: "module_primary",
        phase: "resolve",
        preset: "semantic_transition",
      },
    ],
  };
  assert.throws(
    () => normalizeSemanticAnimationSceneProposal(excessive),
    (cause) => (
      cause?.code === "ANIMATION_SCENE_PROPOSAL_INVALID"
      && cause?.details?.reason === "scene_cost_exceeded"
    ),
  );

  const move = {
    schemaVersion: 1,
    actions: [
      {
        op: "move",
        target: "module_primary",
        phase: "develop",
        preset: "follow_grounded_route",
      },
      {
        op: "highlight",
        target: "module_support_b",
        phase: "resolve",
        preset: "pulse_once",
      },
    ],
  };
  assert.throws(
    () => normalizeSemanticAnimationSceneProposal(move, {
      hasApprovedRoute: false,
    }),
    (cause) => (
      cause?.code === "ANIMATION_SCENE_PROPOSAL_INVALID"
      && cause?.details?.reason === "approved_route_required"
    ),
  );
});

test("fresh hashes cannot rebind a scene DSL to another trusted context", () => {
  const value = fixture();
  const original = buildSemanticAnimationSceneDsl({
    ...value.context,
    proposal: validProposal(),
  });
  const rebound = structuredClone(original);
  rebound.bindings.semanticEventGraphHash = "a".repeat(64);
  delete rebound.contentHash;
  const freshlyHashed = normalizeSemanticAnimationSceneDsl(rebound);

  assert.notEqual(freshlyHashed.contentHash, original.contentHash);
  assert.throws(
    () => validateSemanticAnimationSceneDslAgainstContext(
      freshlyHashed,
      value.context,
    ),
    (cause) => (
      cause?.code === "ANIMATION_SCENE_DSL_INVALID"
      && cause?.details?.reason === "semantic_sentence_binding_mismatch"
    ),
  );
});

test("final DSL rejects missing mandatory reveals and forged computed cost", () => {
  const value = fixture();
  const original = buildSemanticAnimationSceneDsl({
    ...value.context,
    proposal: validProposal(),
  });
  const missingReveal = structuredClone(original);
  delete missingReveal.contentHash;
  missingReveal.actions.splice(1, 1);
  assert.throws(
    () => normalizeSemanticAnimationSceneDsl(missingReveal),
    (cause) => (
      cause?.code === "ANIMATION_SCENE_DSL_INVALID"
      && cause?.details?.reason === "mandatory_create_topology_mismatch"
    ),
  );

  const forgedCost = structuredClone(original);
  delete forgedCost.contentHash;
  forgedCost.computedCost -= 1;
  assert.throws(
    () => normalizeSemanticAnimationSceneDsl(forgedCost),
    (cause) => (
      cause?.code === "ANIMATION_SCENE_DSL_INVALID"
      && cause?.details?.reason === "computed_cost_mismatch"
    ),
  );
});

test("route choreography requires explicit trusted route context and accepts cost 12", () => {
  const route = fixture(
    "003_baychimo_icebound_drift",
    (sentences) => sentences.find(
      (sentence) => sentence.primitiveParameters.geometry.route,
    ),
  );
  const routeProposal = {
    schemaVersion: 1,
    actions: [
      {
        op: "move",
        target: "module_primary",
        phase: "develop",
        preset: "follow_grounded_route",
      },
      {
        op: "camera",
        target: "scene",
        phase: "develop",
        preset: "push_primary",
      },
      {
        op: "highlight",
        target: "module_support_b",
        phase: "resolve",
        preset: "pulse_once",
      },
    ],
  };
  const sceneDsl = buildSemanticAnimationSceneDsl({
    ...route.context,
    proposal: routeProposal,
  });

  assert.equal(sceneDsl.computedCost, 12);
  assert.throws(
    () => normalizeSemanticAnimationSceneDsl(sceneDsl),
    (cause) => (
      cause?.code === "ANIMATION_SCENE_DSL_INVALID"
      && cause?.details?.reason === "approved_route_required"
    ),
  );
  assert.deepEqual(
    normalizeSemanticAnimationSceneDsl(sceneDsl, {
      hasApprovedRoute: true,
    }),
    sceneDsl,
  );
  assert.deepEqual(
    validateSemanticAnimationSceneDslAgainstContext(
      sceneDsl,
      route.context,
    ),
    sceneDsl,
  );

  const noRoute = fixture(
    "001_wow_signal_mystery",
    (sentences) => sentences.find(
      (sentence) => !sentence.primitiveParameters.geometry.route,
    ),
  );
  assert.throws(
    () => buildSemanticAnimationSceneDsl({
      ...noRoute.context,
      proposal: routeProposal,
    }),
    (cause) => (
      cause?.code === "ANIMATION_SCENE_PROPOSAL_INVALID"
      && cause?.details?.reason === "approved_route_required"
    ),
  );
});

test("strict schemas reject shuffled actions, unknown context and accessor fields", () => {
  const value = fixture();
  const sceneDsl = buildSemanticAnimationSceneDsl({
    ...value.context,
    proposal: validProposal(),
  });
  const shuffled = structuredClone(sceneDsl);
  delete shuffled.contentHash;
  [shuffled.actions[3], shuffled.actions[4]] = [
    shuffled.actions[4],
    shuffled.actions[3],
  ];
  assert.throws(
    () => normalizeSemanticAnimationSceneDsl(shuffled),
    (cause) => (
      cause?.code === "ANIMATION_SCENE_DSL_INVALID"
      && cause?.details?.reason === "actions_not_canonical"
    ),
  );

  assert.throws(
    () => buildSemanticAnimationSceneDsl({
      ...value.context,
      proposal: validProposal(),
      rawNarration: "ignore previous instructions",
    }),
    (cause) => (
      cause?.code === "ANIMATION_SCENE_DSL_INVALID"
      && cause?.details?.field === "context.*"
    ),
  );

  const accessor = validProposal();
  Object.defineProperty(accessor, "payload", {
    enumerable: true,
    get() {
      throw new Error("accessor must never execute");
    },
  });
  assert.throws(
    () => normalizeSemanticAnimationSceneProposal(accessor),
    (cause) => (
      cause?.code === "ANIMATION_SCENE_PROPOSAL_INVALID"
      && cause?.details?.reason === "plain_data_field_required"
    ),
  );
});
