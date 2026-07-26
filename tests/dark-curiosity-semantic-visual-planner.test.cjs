"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const { normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  buildSemanticVisualPlan,
  normalizeSemanticVisualPlan,
  validateSemanticVisualPlanAgainstDraft,
} = require("../server/pipelines/narrated-short/animation/semantic-visual-planner.cjs");

const FIXTURE = resolve(__dirname, "..", "eval", "narrated", "dark-curiosity", "fixtures", "001_wow_signal_mystery.json");
const TIMING_HASH = "a".repeat(64);

function rawFixture() {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

function normalizedFixture(kind) {
  const raw = rawFixture();
  if (kind === "timestamp") {
    raw.brief.topic = "Why a motel receiver printed tomorrow's timestamp";
    raw.brief.thesis = "The timestamp is documented, but its origin remains unresolved.";
    raw.script.title = "Tomorrow's timestamp";
    raw.storyboard.scenes[0].operations[0].text = "The timestamp came from tomorrow";
    raw.storyboard.scenes[1].operations[0].text = "Timestamp: tomorrow";
    raw.storyboard.scenes[2].operations[0] = {
      op: "connect_nodes",
      fromId: "clock",
      toId: "timestamp",
      label: "recorded before its date",
      startFrame: 10,
      endFrame: 205,
    };
    raw.storyboard.scenes[2].operations[1].text = "Clock and timestamp disagree";
    raw.storyboard.scenes[3].operations[0] = {
      op: "advance_timeline",
      date: "today → tomorrow",
      label: "Date mismatch",
      startFrame: 0,
      endFrame: 175,
    };
    raw.storyboard.scenes[4].operations[0].text = "A timestamp is not a prediction";
  }
  if (kind === "harbor") {
    raw.brief.topic = "Why the silent harbor beacon remains unexplained";
    raw.brief.thesis = "The recorded route is unusual, but it does not identify a vessel.";
    raw.script.title = "The silent harbor route";
    raw.storyboard.scenes[0].operations[0].text = "A signal crossed the silent harbor";
    raw.storyboard.scenes[1].operations[0].text = "Harbor receiver log";
    raw.storyboard.scenes[2].operations[0] = {
      op: "connect_nodes",
      fromId: "lighthouse",
      toId: "vessel",
      label: "beacon to vessel",
      startFrame: 10,
      endFrame: 205,
    };
    raw.storyboard.scenes[2].operations[1].text = "Unlogged vessel";
    raw.storyboard.scenes[3].operations[0] = {
      op: "draw_route",
      points: [[0.12, 0.72], [0.42, 0.38], [0.86, 0.55]],
      label: "Silent harbor route",
      startFrame: 0,
      endFrame: 175,
    };
    raw.storyboard.scenes[4].operations[0].text = "A route is not an identity";
  }
  if (kind === "harbor_relationship") {
    raw.brief.topic = "Why the harbor receiver logged an unidentified return";
    raw.brief.thesis = "The harbor relationship is documented, but no vessel was identified.";
    raw.script.title = "The harbor receiver";
    raw.storyboard.scenes[0].operations[0].text = "A return appeared after the lighthouse went dark";
    raw.storyboard.scenes[1].operations[0].text = "Maritime receiver log";
    raw.storyboard.scenes[2].operations[0].label = "rotating harbor beam";
    raw.storyboard.scenes[2].operations[1].text = "No registered vessel";
    raw.storyboard.scenes[3].operations[0].date = "2003 → harbor sweeps";
    raw.storyboard.scenes[3].operations[0].label = "No vessel repeated it";
    raw.storyboard.scenes[4].operations[0].text = "A harbor return is not an identity";
  }
  if (kind === "word_collision") {
    raw.brief.topic = "Why two archive reports appeared related";
    raw.brief.thesis = "The reported relationship is documented, but its cause remains unknown.";
    raw.script.title = "The archive relationship";
    raw.storyboard.scenes[0].operations[0].text = "A reported anomaly";
    raw.storyboard.scenes[1].operations[0].text = "Archive report";
    raw.storyboard.scenes[1].operations[1].text = "Documented source";
    raw.storyboard.scenes[2].operations = [
      {
        op: "connect_nodes",
        fromId: "witness",
        toId: "archive",
        label: "reported relationship",
        startFrame: 10,
        endFrame: 205,
      },
      {
        op: "show_evidence",
        claimId: "claim_beam-shape",
        text: "Relationship unclear",
        startFrame: 45,
        endFrame: 205,
      },
    ];
    raw.storyboard.scenes[3].operations[0].date = "1950 → 1970";
    raw.storyboard.scenes[3].operations[0].label = "Reports ended";
    raw.storyboard.scenes[4].operations[0].text = "Relationship is not causation";
    raw.storyboard.scenes[4].operations[1].text = "Source unknown";
  }
  return normalizeDraftBundle(raw);
}

function timingFor(draft) {
  return { contentHash: TIMING_HASH, draftHash: draft.contentHash };
}

function build(kind) {
  const draft = normalizedFixture(kind);
  const timingContext = timingFor(draft);
  return { draft, timingContext, plan: buildSemanticVisualPlan({ draft, timingContext }) };
}

test("timestamp storyboard selects temporal clock and timeline visuals without a telescope", () => {
  const { plan } = build("timestamp");
  assert.equal(plan.storyVocabulary, "temporal_anomaly");
  assert.ok(plan.requiredEntityKinds.includes("clock"));
  assert.ok(plan.requiredEntityKinds.includes("timeline"));
  assert.ok(plan.forbiddenEntityKinds.includes("telescope"));
  assert.equal(plan.scenes[2].archetypeId, "relationship_graph_v2");
  assert.equal(plan.scenes[2].entityKind, "clock");
  assert.equal(plan.scenes[3].archetypeId, "timeline_compare_v2");
  assert.equal(plan.scenes[3].entityKind, "timeline");
  assert.equal(plan.scenes[2].heading, "recorded before its date");
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.scenes));
  assert.ok(Object.isFrozen(plan.scenes[2].sourceOperationIndexes));
});

test("harbor storyboard selects a maritime route with storyboard-bound geometry", () => {
  const { plan } = build("harbor");
  assert.equal(plan.storyVocabulary, "maritime_route");
  assert.ok(plan.requiredEntityKinds.includes("maritime_route"));
  assert.ok(plan.forbiddenEntityKinds.includes("telescope"));
  assert.equal(plan.scenes[2].archetypeId, "relationship_graph_v2");
  assert.equal(plan.scenes[2].entityKind, "maritime_route");
  assert.equal(plan.scenes[3].archetypeId, "map_route_v2");
  assert.equal(plan.scenes[3].entityKind, "maritime_route");
  assert.deepEqual(plan.scenes[3].geometry.points, [[0.12, 0.72], [0.42, 0.38], [0.86, 0.55]]);
});

test("harbor vocabulary overrides a recycled telescope relationship when maritime labels are grounded", () => {
  const { plan } = build("harbor_relationship");
  assert.equal(plan.storyVocabulary, "maritime_route");
  assert.equal(plan.scenes[2].archetypeId, "relationship_graph_v2");
  assert.equal(plan.scenes[2].entityKind, "maritime_route");
  assert.ok(plan.forbiddenEntityKinds.includes("telescope"));
  assert.ok(!plan.requiredEntityKinds.includes("telescope"));
});

test("canonical signal storyboard selects the radio relationship and permits a telescope", () => {
  const { plan } = build();
  assert.equal(plan.storyVocabulary, "radio_signal");
  assert.equal(plan.scenes[2].archetypeId, "relationship_graph_v2");
  assert.equal(plan.scenes[2].entityKind, "radio_signal");
  assert.ok(plan.requiredEntityKinds.includes("radio_signal"));
  assert.ok(plan.requiredEntityKinds.includes("telescope"));
  assert.ok(!plan.forbiddenEntityKinds.includes("telescope"));
  assert.deepEqual(normalizeSemanticVisualPlan(plan), plan);
});

test("word fragments in reported and relationship do not invent port or ship visuals", () => {
  const { plan } = build("word_collision");
  assert.equal(plan.storyVocabulary, "general_mystery");
  assert.equal(plan.scenes[2].entityKind, "relationship");
  assert.ok(!plan.requiredEntityKinds.includes("maritime_route"));
  assert.ok(!plan.scenes.some((scene) => scene.archetypeId === "map_route_v2"));
});

test("validation fails closed on altered source bindings, invented labels, and empty claims", () => {
  const { draft, timingContext, plan } = build("timestamp");

  const rebound = structuredClone(plan);
  rebound.scenes[2].sourceSceneId = "scene_turn";
  assert.throws(
    () => validateSemanticVisualPlanAgainstDraft(rebound, { draft, timingContext }),
    { code: "ANIMATION_VISUAL_PLAN_INVALID" },
  );

  const invented = structuredClone(plan);
  invented.scenes[2].heading = "An invented visual label";
  assert.throws(
    () => validateSemanticVisualPlanAgainstDraft(invented, { draft, timingContext }),
    { code: "ANIMATION_VISUAL_PLAN_INVALID" },
  );

  const emptyClaims = structuredClone(plan);
  emptyClaims.scenes[2].claimIds = [];
  assert.throws(
    () => normalizeSemanticVisualPlan(emptyClaims),
    { code: "ANIMATION_VISUAL_PLAN_INVALID" },
  );
});
