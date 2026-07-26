import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import {
  archetypeSceneMarkup,
  semanticPrimitivePaths,
} from "../renderer/hyperframes/primitives/semantic-shapes.mjs";

const require = createRequire(import.meta.url);
const { normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  buildSemanticVisualPlan,
} = require("../server/pipelines/narrated-short/animation/semantic-visual-planner.cjs");

const FIXTURE = resolve(
  import.meta.dirname,
  "..",
  "eval",
  "narrated",
  "dark-curiosity",
  "fixtures",
  "003_baychimo_icebound_drift.json",
);
const TIMING_HASH = "b".repeat(64);

function baychimoPlan() {
  const draft = normalizeDraftBundle(JSON.parse(readFileSync(FIXTURE, "utf8")));
  return buildSemanticVisualPlan({
    draft,
    timingContext: {
      contentHash: TIMING_HASH,
      draftHash: draft.contentHash,
    },
  });
}

test("Baychimo keeps maritime semantics but selects the Arctic drift entity pack", () => {
  const first = baychimoPlan();
  const second = baychimoPlan();

  assert.deepEqual(first, second);
  assert.equal(first.storyVocabulary, "maritime_route");
  assert.ok(first.requiredEntityKinds.includes("maritime_route"));
  assert.ok(first.requiredEntityKinds.includes("arctic_drift"));
  assert.ok(first.forbiddenEntityKinds.includes("telescope"));
  assert.deepEqual(
    first.scenes.map((scene) => scene.entityKind),
    ["arctic_drift", "evidence_record", "arctic_drift", "arctic_drift", "bounded_verdict"],
  );
  assert.equal(new Set(first.scenes.map((scene) => scene.entityKind)).size, 3);
  assert.equal(first.scenes[3].archetypeId, "map_route_v2");
  assert.deepEqual(first.scenes[3].geometry.points, [[0.16, 0.7], [0.36, 0.5], [0.61, 0.34], [0.84, 0.2]]);
  assert.equal(first.scenes[3].disclosure, "Approximate path; not an exact track.");
});

test("Arctic drift markup renders pack ice, a steamer, and geometry-bound sighting markers", () => {
  const plan = baychimoPlan();
  const first = plan.scenes.map((scene) => archetypeSceneMarkup(scene, scene.role)).join("\n");
  const second = plan.scenes.map((scene) => archetypeSceneMarkup(scene, scene.role)).join("\n");
  const turn = archetypeSceneMarkup(plan.scenes[3], "turn");

  assert.equal(first, second);
  assert.equal((first.match(/data-motif-kind="arctic_drift"/g) || []).length, 3);
  assert.equal((first.match(/data-motif-kind="evidence"/g) || []).length, 1);
  assert.match(first, /class="pack-ice"/);
  assert.match(first, /class="icebound-steamer/);
  assert.match(first, /data-arctic-feature="under-ice-current"/);
  assert.match(first, /data-arctic-feature="sightings"/);
  assert.match(turn, /transform="translate\(180\.48 630\)"/);
  assert.match(turn, /transform="translate\(286\.08 570\)"/);
  assert.match(turn, /transform="translate\(418\.08 522\)"/);
  assert.match(turn, /transform="translate\(539\.52 480\)"/);
  assert.equal((turn.match(/data-sighting-index=/g) || []).length, 4);
  assert.doesNotMatch(first, /lighthouse|beacon-fill|data-motif-kind="harbor_route"/i);
  assert.doesNotMatch(first, /…/);
});

test("generic harbor routes retain the lighthouse motif instead of becoming Arctic", () => {
  const harbor = {
    archetypeId: "map_route_v2",
    heading: "SILENT HARBOR ROUTE",
    primaryLabel: "BEYOND THE BREAKWATER",
    secondaryLabel: "VESSEL IDENTITY UNKNOWN",
    entityKind: "maritime_route",
    geometry: { points: [[0.12, 0.72], [0.42, 0.38], [0.86, 0.55]] },
  };
  const markup = archetypeSceneMarkup(harbor, "turn");

  assert.match(markup, /data-motif-kind="harbor_route"/);
  assert.match(markup, /class="lighthouse/);
  assert.match(markup, /class="vessel/);
  assert.doesNotMatch(markup, /arctic_drift|pack-ice|icebound-steamer/);
});

test("D3 Arctic primitives are deterministic and distinct from harbor geometry", () => {
  const first = semanticPrimitivePaths("arctic_drift");
  const second = semanticPrimitivePaths("icebound_arctic_vessel");
  const harbor = semanticPrimitivePaths("maritime_route");

  assert.deepEqual(first, second);
  assert.match(first.packEdge, /^M84,690/);
  assert.match(first.drift, /^M128,652/);
  assert.match(first.current, /^M104,724/);
  assert.notDeepEqual(first, harbor);
});
