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
  validateAnimationIR,
} = require("../server/pipelines/narrated-short/animation/contract.cjs");
const {
  buildGeneralizedSemanticArtifacts,
} = require("../server/pipelines/narrated-short/animation/generalized-semantic-event-planner.cjs");
const {
  quantityTokens,
} = require("../server/pipelines/narrated-short/animation/generalized-semantic-event-manifest.cjs");
const {
  normalizeSemanticEventGraph,
  validateSemanticEventGraphAgainstDraft,
} = require("../server/pipelines/narrated-short/animation/semantic-event-graph.cjs");
const {
  buildVisualIntentGraph,
  normalizeVisualIntentGraph,
  validateVisualIntentGraphAgainstStoryIR,
  visualIntentGraphContentHash,
} = require("../server/pipelines/narrated-short/animation/generalized-visual-intent-planner.cjs");
const {
  findSemanticEventProfile,
  listSemanticEventProfiles,
} = require("../server/pipelines/narrated-short/animation/semantic-event-profile-registry.cjs");
const {
  compileProductionAnimation,
} = require("../server/pipelines/narrated-short/animation/production-plan-compiler.cjs");
const {
  SEMANTIC_SENTENCE_PROFILE_ID,
  SEMANTIC_SENTENCE_RENDERER_ASSET_IDS,
  SEMANTIC_SENTENCE_RENDERER_GRAMMAR_ASSET_BINDINGS,
  SEMANTIC_SENTENCE_RENDERER_GRAMMAR_IDS,
} = require("../server/pipelines/narrated-short/animation/semantic-render-profile.cjs");
const {
  buildSemanticVisualSentencePlan,
  normalizeSemanticVisualSentencePlan,
  semanticVisualSentencePlanContentHash,
  validateSemanticVisualSentencePlanAgainstGraph,
} = require("../server/pipelines/narrated-short/animation/semantic-visual-sentence-planner.cjs");
const {
  SEMANTIC_PRIMITIVE_PARAMETER_PROFILE_ID,
  SEMANTIC_PRIMITIVE_PARAMETER_SCHEMA_VERSION,
  SEMANTIC_PRIMITIVE_PRESET_BY_GRAMMAR,
  SEMANTIC_PRIMITIVE_STATE_TOKENS,
  normalizeSemanticPrimitiveParameters,
} = require("../server/pipelines/narrated-short/animation/semantic-primitive-parameters.cjs");
const {
  semanticBoundedValueRangeClaimMatches,
  semanticCounterCapacityComparisonClaimMatches,
  semanticCounterMappingClaimMatches,
  semanticCounterNotTimeClaimMatches,
  semanticEncodedBitClaimMatches,
  semanticNeutralDocumentCueMatches,
  semanticNeutralNetworkCueMatches,
  semanticNeutralQuoteCueMatches,
} = require("../server/pipelines/narrated-short/animation/semantic-visual-concept-registry.cjs");
const {
  SEMANTIC_SCENE_COMPOSITION_LAYOUT_IDS,
  SEMANTIC_SCENE_COMPOSITION_MODULE_KINDS,
  SEMANTIC_SCENE_COMPOSITION_PROFILE_ID,
  SEMANTIC_SCENE_COMPOSITION_SCHEMA_VERSION,
  buildSemanticSceneComposition,
  normalizeSemanticSceneComposition,
} = require("../server/pipelines/narrated-short/animation/semantic-scene-composition.cjs");
const {
  SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID,
  buildSemanticSimpleExplainerGroups,
} = require("../server/pipelines/narrated-short/animation/semantic-simple-explainer.cjs");
const {
  MAX_GEOMETRY_EDGES,
  MAX_GEOMETRY_NODES,
  SEMANTIC_GEOMETRY_BLUEPRINT_PROFILE_ID,
  SEMANTIC_GEOMETRY_BLUEPRINT_SCHEMA_VERSION,
  SEMANTIC_GEOMETRY_NODE_RANGE_BY_RECIPE,
  SEMANTIC_GEOMETRY_PROGRAM_PROFILE_ID,
  SEMANTIC_GEOMETRY_RECIPE_BY_GRAMMAR,
  buildSemanticGeometryBlueprint,
  compileSemanticGeometryProgram,
  normalizeSemanticGeometryBlueprint,
  normalizeSemanticGeometryProgram,
  primitiveParametersHash,
  validateSemanticGeometryBlueprintAgainstContext,
} = require("../server/pipelines/narrated-short/animation/semantic-geometry-blueprint.cjs");
const {
  buildDeterministicSemanticAnimationSceneDslPlan,
  buildSemanticAnimationSceneDslPlanFromScenes,
} = require("../server/pipelines/narrated-short/animation/semantic-animation-scene-dsl-plan.cjs");
const {
  assertSemanticVisualCoherence,
  buildSemanticVisualCoherenceReport,
  primaryVisualFormSignature,
} = require("../server/pipelines/narrated-short/animation/semantic-visual-coherence-qa.cjs");
const {
  buildSemanticAnimationSceneDsl,
} = require("../server/pipelines/narrated-short/animation/semantic-animation-scene-dsl.cjs");
const {
  planSemanticAnimationScenes,
} = require("../server/pipelines/narrated-short/animation/semantic-animation-scene-plan-service.cjs");
const {
  MAX_SEGMENT_CHARACTERS,
  MAX_SEGMENT_LINES,
  buildStoryIR,
  normalizeStoryIR,
  storyIRContentHash,
  validateStoryIRAgainstDraft,
} = require("../server/pipelines/narrated-short/animation/story-ir.cjs");
const {
  normalizeAnimationTimingContext,
} = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");
const {
  motionSegments,
} = require("../server/pipelines/narrated-short/animation/render-service.cjs");

const ROOT = resolve(__dirname, "..");
const CASES = Object.freeze([
  ["001_wow_signal_mystery", "radio_signal"],
  ["002_gps_week_rollover", "temporal_anomaly"],
  ["003_baychimo_icebound_drift", "maritime_route"],
  ["004_general_word_collision", "general_mystery"],
]);

function readRaw(id) {
  const fixtureId = id === "004_general_word_collision"
    ? "001_wow_signal_mystery"
    : id;
  const raw = JSON.parse(readFileSync(resolve(
    ROOT,
    "eval",
    "narrated",
    "dark-curiosity",
    "fixtures",
    `${fixtureId}.json`,
  ), "utf8"));
  if (id !== "004_general_word_collision") return raw;
  raw.brief.topic = "Why two archive reports appeared related";
  raw.brief.thesis =
    "The reported relationship is documented, but its cause remains unknown.";
  raw.brief.targetSeconds = 28;
  raw.script.title = "The archive relationship";
  raw.script.estimatedSeconds = 28;
  const generalBeats = [
    [
      "Two archive reports described matching marks across different decades.",
      "Two reports, one pattern",
    ],
    [
      "The first ledger names a witness, while the second records an unknown location.",
      "Two ledgers disagree",
    ],
    [
      "Their dates align, but the paper and ink were produced years apart.",
      "Dates align, materials do not",
    ],
    [
      "No verified chain connects the documents, and copying remains possible.",
      "No verified chain",
    ],
    [
      "The relationship is documented, not causation; the source remains unresolved.",
      "Relationship is not causation",
    ],
  ];
  raw.script.beats.forEach((beat, index) => {
    [beat.spokenText, beat.onScreenText] = generalBeats[index];
  });
  const generalClaims = [
    "Two archive reports describe matching marks in records from different decades.",
    "The first report names a witness while the second records a different location.",
    "The report dates align, but their physical materials were produced years apart.",
    "No verified provenance chain connects the two documents.",
    "The relationship is documented, but the available evidence does not establish causation.",
  ];
  raw.claimLedger.claims.forEach((claim, index) => {
    claim.text = generalClaims[index];
  });
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
  return raw;
}

function readBaychimoWithGroundedRoute() {
  const raw = readRaw("003_baychimo_icebound_drift");
  raw.storyboard.scenes[2].template = "map_timeline_scene";
  raw.storyboard.scenes[2].operations = structuredClone(
    raw.storyboard.scenes[3].operations,
  );
  raw.storyboard.scenes[2].operations[0].label = "APPROXIMATE DRIFT ROUTE";
  return raw;
}

function readGpsWithExplicitCounterMechanism() {
  const raw = readRaw("002_gps_week_rollover");
  raw.script.beats[4].spokenText =
    "The GPS week counter mapping mechanism was ordinary. The number reset, not time itself.";
  return raw;
}

function readGpsWithExplicitCounterNotTime() {
  const raw = readRaw("002_gps_week_rollover");
  raw.script.beats[4].spokenText =
    "The counter reset was not time.";
  return raw;
}

function timingFor(draft, salt = "generic", pauseFrames = 16, leadingFrames = 0) {
  let frame = leadingFrames;
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
    frame += pauseFrames;
  }
  return normalizeAnimationTimingContext({
    schemaVersion: 1,
    fps: 30,
    durationFrames: frame + 30,
    alignmentHash: createHash("sha256")
      .update(`${salt}:${draft.contentHash}`)
      .digest("hex"),
    draftHash: draft.contentHash,
    words,
    beats,
  });
}

function build(id, salt = id) {
  const draft = normalizeDraftBundle(readRaw(id));
  const timingContext = timingFor(draft, salt);
  const storyIR = buildStoryIR({ draft, timingContext });
  const visualIntentGraph = buildVisualIntentGraph(storyIR, { draft, timingContext });
  const semantic = buildGeneralizedSemanticArtifacts({ draft, timingContext });
  const sentencePlan = buildSemanticVisualSentencePlan(semantic.semanticEventGraph);
  return { draft, timingContext, storyIR, visualIntentGraph, semantic, sentencePlan };
}

function compileRaw(raw, salt, projectId) {
  const draft = normalizeDraftBundle(raw);
  const timingContext = timingFor(draft, salt);
  const compiled = compileProductionAnimation({
    animationProfile: "semantic-v3",
    projectId,
    projectRevision: 1,
    renderProfile: "preview",
    draft,
    timingContext,
  });
  return { draft, timingContext, compiled };
}

function assertHeadingIsSourceSubsequence(source, heading, label = heading) {
  const lexicalTokens = (value) => (
    String(value).toLocaleLowerCase("en-US")
      .match(/[a-z0-9]+(?:['’][a-z0-9]+)?/g) || []
  );
  const sourceTokens = lexicalTokens(source);
  const headingTokens = lexicalTokens(heading);
  let sourceIndex = -1;
  for (const token of headingTokens) {
    sourceIndex = sourceTokens.indexOf(token, sourceIndex + 1);
    assert.notEqual(sourceIndex, -1, `${label}: invented or reordered token ${token}`);
  }
}

function alternateSceneDslPlan(compiled) {
  const defaultPlan =
    compiled.animationIR.content.semanticAnimationSceneDslPlan;
  const sentencePlan =
    compiled.animationIR.content.semanticVisualSentencePlan;
  const sentenceIndex = sentencePlan.sentences.findIndex(
    (sentence) => sentence.primitiveParameters.geometry.route === null,
  );
  assert.ok(sentenceIndex >= 0);
  const sentence = sentencePlan.sentences[sentenceIndex];
  const replacement = buildSemanticAnimationSceneDsl({
    semanticEventGraphHash:
      compiled.animationIR.content.semanticEventGraph.contentHash,
    semanticVisualSentencePlanHash: sentencePlan.contentHash,
    propositionId: sentence.propositionId,
    primitiveParameters: sentence.primitiveParameters,
    sceneComposition: sentence.sceneComposition,
    proposal: {
      schemaVersion: 1,
      actions: [
        {
          op: "highlight",
          target: "module_primary",
          phase: "develop",
          preset: "pulse_once",
        },
        {
          op: "camera",
          target: "scene",
          phase: "resolve",
          preset: "pull_overview",
        },
      ],
    },
  });
  assert.notDeepEqual(
    replacement.actions,
    defaultPlan.scenes[sentenceIndex].sceneDsl.actions,
  );
  return buildSemanticAnimationSceneDslPlanFromScenes({
    bindings: defaultPlan.bindings,
    planner: defaultPlan.planner,
    scenes: defaultPlan.scenes.map((scene, index) => ({
      propositionId: scene.propositionId,
      provenance: scene.provenance,
      sceneDsl: index === sentenceIndex ? replacement : scene.sceneDsl,
    })),
  });
}

function rendererSourceOptions(value) {
  return {
    semanticSourceContext: {
      draft: value.draft,
      timingContext: value.timingContext,
    },
  };
}

function signature(graph) {
  return graph.intents.map((intent) => [
    intent.visualIntent.predicate,
    intent.visualIntent.subjectKind,
    intent.visualIntent.stateTransition,
  ].join(":"));
}

function assertDeepFrozen(value, field = "artifact", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true, `${field} must be frozen`);
  for (const [key, child] of Object.entries(value)) {
    assertDeepFrozen(child, `${field}.${key}`, seen);
  }
}

function assertFailure(action, code, reason) {
  assert.throws(action, (error) => {
    assert.equal(error?.code, code);
    assert.equal(error?.details?.reason, reason);
    return true;
  });
}

function expectedCompositionSupportKind(primitiveParameters) {
  if (primitiveParameters.geometry.route) return "route_trace";
  if (primitiveParameters.quantity) {
    const displayQuantity = [
      primitiveParameters.quantity.value,
      primitiveParameters.quantity.unit,
    ].filter(Boolean).join(" ").trim();
    if (displayQuantity && displayQuantity.length <= 32) {
      return "quantity_badge";
    }
  }
  return "detail_card";
}

function rebindSyntheticGeometryBlueprint(sentence) {
  const semanticEventGraphHash = sentence.sceneComposition.geometryBlueprint
    .bindings.semanticEventGraphHash;
  sentence.sceneComposition.geometryBlueprint = buildSemanticGeometryBlueprint({
    semanticEventGraphHash,
    propositionId: sentence.propositionId,
    primitiveParameters: sentence.primitiveParameters,
  });
  return sentence;
}

function rebindSyntheticSceneComposition(sentence) {
  const graphHash = sentence.sceneComposition.geometryBlueprint
    .bindings.semanticEventGraphHash;
  sentence.sceneComposition = buildSemanticSceneComposition({
    graphHash,
    propositionId: sentence.propositionId,
    primitiveParameters: sentence.primitiveParameters,
    capability: sentence.capability,
    recentLayoutIds: [],
  });
  return sentence;
}

test("three unrelated stories build deterministic grounded StoryIR and visual intent graphs", () => {
  const signatures = [];
  const grammarSequences = [];
  const vocabularies = [];
  for (const [id, expectedVocabulary] of CASES) {
    const first = build(id);
    const secondStoryIR = buildStoryIR({
      draft: structuredClone(first.draft),
      timingContext: structuredClone(first.timingContext),
    });
    const secondGraph = buildVisualIntentGraph(structuredClone(secondStoryIR), {
      draft: first.draft,
      timingContext: first.timingContext,
    });
    assert.deepEqual(secondStoryIR, first.storyIR);
    assert.deepEqual(secondGraph, first.visualIntentGraph);
    assert.equal(first.storyIR.contentHash, storyIRContentHash(first.storyIR));
    assert.equal(
      first.visualIntentGraph.contentHash,
      visualIntentGraphContentHash(first.visualIntentGraph),
    );
    assert.deepEqual(
      validateStoryIRAgainstDraft(first.storyIR, {
        draft: first.draft,
        timingContext: first.timingContext,
      }),
      first.storyIR,
    );
    assert.deepEqual(
      validateVisualIntentGraphAgainstStoryIR(
        first.visualIntentGraph,
        first.storyIR,
        { draft: first.draft, timingContext: first.timingContext },
      ),
      first.visualIntentGraph,
    );
    assert.equal(first.storyIR.storyVocabulary, expectedVocabulary);
    assert.equal(
      first.visualIntentGraph.bindings.storyIRHash,
      first.storyIR.contentHash,
    );
    assert.equal(
      first.visualIntentGraph.bindings.alignmentHash,
      first.timingContext.alignmentHash,
    );
    assertDeepFrozen(first.storyIR, `${id}.storyIR`);
    assertDeepFrozen(first.visualIntentGraph, `${id}.visualIntentGraph`);
    assertDeepFrozen(first.semantic, `${id}.semantic`);
    signatures.push(signature(first.visualIntentGraph));
    grammarSequences.push(first.sentencePlan.sentences.map(
      (sentence) => sentence.capability.grammarId,
    ));
    vocabularies.push(first.storyIR.storyVocabulary);
    for (const sentence of first.sentencePlan.sentences) {
      assert.ok(SEMANTIC_SENTENCE_RENDERER_ASSET_IDS.includes(sentence.capability.assetId));
      assert.ok(SEMANTIC_SENTENCE_RENDERER_GRAMMAR_IDS.includes(sentence.capability.grammarId));
    }
  }
  assert.equal(new Set(vocabularies).size, CASES.length);
  for (let left = 0; left < CASES.length; left += 1) {
    for (let right = left + 1; right < CASES.length; right += 1) {
      assert.notDeepEqual(signatures[left], signatures[right]);
      assert.notDeepEqual(grammarSequences[left], grammarSequences[right]);
    }
  }
});

test("generic words cannot trigger GPS-only visual concepts in unrelated stories", async () => {
  const primitives = await import(
    "../renderer/hyperframes/primitives/semantic-sentence-primitives.mjs"
  );
  const buildAdversarialPlan = (raw, salt) => {
    const draft = normalizeDraftBundle(raw);
    const timingContext = timingFor(draft, salt);
    const semantic = buildGeneralizedSemanticArtifacts({
      draft,
      timingContext,
    });
    return buildSemanticVisualSentencePlan(semantic.semanticEventGraph);
  };
  const compileBaychimo = (raw, salt) => buildAdversarialPlan(raw, salt);

  const misreadRaw = readRaw("003_baychimo_icebound_drift");
  misreadRaw.script.beats[1].spokenText =
    "The harbor log was misread, but local hunters soon spotted the abandoned steamer near the Alaskan coast.";
  const misreadPlan = compileBaychimo(
    misreadRaw,
    "baychimo-misread-guard",
  );
  const misread = misreadPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("harbor log was misread"),
  );
  assert.ok(misread);
  assert.equal(
    misread.primitiveParameters.visualConceptId,
    "source_misinterpretation",
  );
  assert.equal(misread.capability.assetId, "mapping_table");
  assert.doesNotMatch(
    primitives.semanticSentencePrimitiveMarkup(
      misread,
      misreadPlan.sentences.indexOf(misread),
    ),
    /WEEK VALUE|GPS VALUE|DATE ERROR|counter_date_misinterpretation/,
  );

  const updatedRaw = readRaw("003_baychimo_icebound_drift");
  updatedRaw.script.beats[3].spokenText =
    "The archive was updated in 1969, decades after the ship was abandoned.";
  const updatedPlan = compileBaychimo(
    updatedRaw,
    "baychimo-updated-guard",
  );
  const updated = updatedPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("archive was updated"),
  );
  assert.ok(updated);
  assert.notEqual(
    updated.primitiveParameters.visualConceptId,
    "receiver_patch_required",
  );
  assert.doesNotMatch(
    primitives.semanticSentencePrimitiveMarkup(
      updated,
      updatedPlan.sentences.indexOf(updated),
    ),
    /SOFTWARE PATCH|UPDATE REQUIRED|receiver_patch_required/,
  );

  const distanceRaw = readRaw("003_baychimo_icebound_drift");
  distanceRaw.script.beats[2].spokenText =
    "Over the following years, people saw the ship at a greater distance from shore as it drifted with Arctic pack ice.";
  const distancePlan = compileBaychimo(
    distanceRaw,
    "baychimo-distance-guard",
  );
  const distance = distancePlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("greater distance"),
  );
  assert.ok(distance);
  assert.notEqual(
    distance.primitiveParameters.visualConceptId,
    "counter_capacity_comparison",
  );
  assert.doesNotMatch(
    primitives.semanticSentencePrimitiveMarkup(
      distance,
      distancePlan.sentences.indexOf(distance),
    ),
    /data-comparison-concept="capacity"|>LEGACY<|>MORE ROOM</,
  );

  const wrongArchiveDateRaw = readRaw("003_baychimo_icebound_drift");
  wrongArchiveDateRaw.script.beats[1].spokenText =
    "The date in the harbor log looked wrong, but local hunters still identified the abandoned steamer near the Alaskan coast.";
  const wrongArchiveDatePlan = compileBaychimo(
    wrongArchiveDateRaw,
    "baychimo-wrong-date-guard",
  );
  const wrongArchiveDate = wrongArchiveDatePlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("harbor log looked wrong"),
  );
  assert.ok(wrongArchiveDate);
  assert.equal(
    wrongArchiveDate.primitiveParameters.visualConceptId,
    "date_source_misinterpretation",
  );
  assert.notEqual(
    wrongArchiveDate.primitiveParameters.visualConceptId,
    "counter_date_misinterpretation",
  );

  const futureSightingRaw = readRaw("003_baychimo_icebound_drift");
  futureSightingRaw.script.beats[3].spokenText =
    "The archive predicted another sighting in 1969, decades after the ship was abandoned.";
  const futureSightingPlan = compileBaychimo(
    futureSightingRaw,
    "baychimo-future-event-guard",
  );
  const futureSighting = futureSightingPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("another sighting in 1969"),
  );
  assert.ok(futureSighting);
  assert.equal(
    futureSighting.primitiveParameters.visualConceptId,
    "future_event_timeline",
  );
  assert.notEqual(
    futureSighting.primitiveParameters.visualConceptId,
    "future_rollover_timeline",
  );

  const icePatchesRaw = readRaw("003_baychimo_icebound_drift");
  icePatchesRaw.script.beats[2].spokenText =
    "Patches of Arctic ice covered the equipment on the ship while it drifted farther from the Alaskan coast.";
  const icePatchesPlan = compileBaychimo(
    icePatchesRaw,
    "baychimo-ice-patches-guard",
  );
  const icePatches = icePatchesPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("Patches of Arctic ice"),
  );
  assert.ok(icePatches);
  assert.notEqual(
    icePatches.primitiveParameters.visualConceptId,
    "source_remediation",
  );
  assert.notEqual(
    icePatches.primitiveParameters.visualConceptId,
    "receiver_patch_required",
  );

  const badlyDamagedRaw = readRaw("003_baychimo_icebound_drift");
  badlyDamagedRaw.script.beats[2].spokenText =
    "The ship was badly damaged by pack ice while it drifted through Arctic water.";
  const badlyDamagedPlan = compileBaychimo(
    badlyDamagedRaw,
    "baychimo-badly-damaged-guard",
  );
  const badlyDamaged = badlyDamagedPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("badly damaged"),
  );
  assert.ok(badlyDamaged);
  assert.notEqual(
    badlyDamaged.primitiveParameters.visualConceptId,
    "source_misinterpretation",
  );

  for (const [salt, spokenText, phrase] of [
    [
      "baychimo-reset-button-is-not-reappearance",
      "The ship sat beside a reset button on the abandoned control panel.",
      "reset button",
    ],
    [
      "baychimo-archive-reset-button-is-not-reappearance",
      "The harbor archive stored a reset button beside a weathered navigation chart.",
      "archive stored a reset button",
    ],
    [
      "baychimo-repeated-pattern-is-not-reappearance",
      "The crew discussed a repeated pattern painted on the cabin wall.",
      "repeated pattern",
    ],
  ]) {
    const raw = readRaw("003_baychimo_icebound_drift");
    raw.script.beats[2].spokenText = spokenText;
    const plan = compileBaychimo(raw, salt);
    const sentence = plan.sentences.find(
      (candidate) => candidate.wordSpan.text.includes(phrase),
    );
    assert.ok(sentence, salt);
    assert.match(
      sentence.primitiveParameters.visualConceptId,
      /^cue_evidence_(?:bands|document|field|focus|frame|network|quote|ribbon|spotlight)$/,
      salt,
    );
    assert.notEqual(
      sentence.primitiveParameters.visualConceptId,
      "semantic_vessel_recurrence",
      salt,
    );
    assert.equal(sentence.visualIntent.predicate, "appearance", salt);
    assert.equal(sentence.visualIntent.stateTransition, "become_visible", salt);
  }

  const nonGpsTemporalBase = JSON.parse(
    JSON.stringify(readRaw("002_gps_week_rollover"))
      .replace(/gps/gi, "system"),
  );
  nonGpsTemporalBase.script.beats[0].spokenText =
    "At midnight, the clock displayed an impossible time, although its oscillator continued normally.";
  const nonGpsClockPlan = buildAdversarialPlan(
    nonGpsTemporalBase,
    "non-gps-impossible-time-guard",
  );
  const impossibleTime = nonGpsClockPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("impossible time"),
  );
  assert.ok(impossibleTime);
  assert.equal(
    impossibleTime.primitiveParameters.visualConceptId,
    "date_source_misinterpretation",
  );
  const impossibleTimeMarkup = primitives.semanticSentencePrimitiveMarkup(
    impossibleTime,
    nonGpsClockPlan.sentences.indexOf(impossibleTime),
  );
  assert.doesNotMatch(
    impossibleTimeMarkup,
    /data-cause-concept="wrong_date"|DATE ERROR|RECEIVER RULE/,
  );

  const rememberedYearRaw = structuredClone(nonGpsTemporalBase);
  rememberedYearRaw.script.beats[3].spokenText =
    "In 1999 the device will be remembered by engineers, while its clock continued normally.";
  const rememberedYear = buildAdversarialPlan(
    rememberedYearRaw,
    "non-gps-remembered-year-guard",
  ).sentences.find(
    (sentence) => sentence.wordSpan.text.includes("will be remembered"),
  );
  assert.ok(rememberedYear);
  assert.notEqual(
    rememberedYear.primitiveParameters.visualConceptId,
    "future_rollover_timeline",
  );
  assert.notEqual(
    rememberedYear.primitiveParameters.visualConceptId,
    "future_event_timeline",
  );

  const unrelatedGpsCauseRaw = readRaw("002_gps_week_rollover");
  unrelatedGpsCauseRaw.script.beats[2].spokenText =
    "Heavy rain caused the launch time to change before the documented event.";
  const unrelatedGpsCausePlan = buildAdversarialPlan(
    unrelatedGpsCauseRaw,
    "gps-unrelated-cause-guard",
  );
  const unrelatedGpsCause = unrelatedGpsCausePlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("rain caused the launch time"),
  );
  assert.ok(unrelatedGpsCause);
  assert.equal(
    unrelatedGpsCause.primitiveParameters.visualConceptId,
    "mapping_cause_effect",
  );
  assert.notEqual(
    unrelatedGpsCause.primitiveParameters.visualConceptId,
    "counter_mapping_mechanism",
  );
  assert.doesNotMatch(
    primitives.semanticSentencePrimitiveMarkup(
      unrelatedGpsCause,
      unrelatedGpsCausePlan.sentences.indexOf(unrelatedGpsCause),
    ),
    /RECEIVER RULE|LAST→0|counter_mapping_mechanism/,
  );

  const futureCounterRaw = readRaw("002_gps_week_rollover");
  futureCounterRaw.script.beats[3].spokenText =
    "The legacy counter will roll over in 2038, while newer navigation messages provide more room.";
  const futureCounterPlan = buildAdversarialPlan(
    futureCounterRaw,
    "gps-will-roll-over-positive-guard",
  );
  const futureCounter = futureCounterPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("will roll over in 2038"),
  );
  assert.ok(futureCounter);
  assert.equal(
    futureCounter.primitiveParameters.visualConceptId,
    "future_rollover_timeline",
  );
  assert.equal(futureCounter.primitiveParameters.stateToken, "UPCOMING");

  const inspectedCounterRaw = readRaw("002_gps_week_rollover");
  inspectedCounterRaw.script.beats[3].spokenText =
    "The GPS counter will be inspected in 2038, while engineers document its current behavior.";
  const inspectedCounterPlan = buildAdversarialPlan(
    inspectedCounterRaw,
    "gps-counter-inspection-is-not-rollover",
  );
  const inspectedCounter = inspectedCounterPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("will be inspected in 2038"),
  );
  assert.ok(inspectedCounter);
  assert.notEqual(
    inspectedCounter.primitiveParameters.visualConceptId,
    "future_rollover_timeline",
  );

  const wrappedCounterRaw = readRaw("002_gps_week_rollover");
  wrappedCounterRaw.script.beats[0].spokenText =
    "The legacy GPS week counter wrapped to zero, and some devices displayed the wrong date.";
  const wrappedCounterPlan = buildAdversarialPlan(
    wrappedCounterRaw,
    "gps-wrapped-to-zero-positive-guard",
  );
  const wrappedCounter = wrappedCounterPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("wrapped to zero"),
  );
  assert.ok(wrappedCounter);
  assert.equal(
    wrappedCounter.primitiveParameters.visualConceptId,
    "finite_counter_wrap",
  );
  assert.match(
    primitives.semanticSentencePrimitiveMarkup(
      wrappedCounter,
      wrappedCounterPlan.sentences.indexOf(wrappedCounter),
    ),
    />ZERO</,
  );

  const encodedIdentifierRaw = readRaw("002_gps_week_rollover");
  encodedIdentifierRaw.script.beats[1].spokenText =
    "The receiver encoded its identifier in a field for compatibility.";
  const encodedIdentifierPlan = buildAdversarialPlan(
    encodedIdentifierRaw,
    "gps-encoded-identifier-is-not-bit-register",
  );
  const encodedIdentifier = encodedIdentifierPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("encoded its identifier"),
  );
  assert.ok(encodedIdentifier);
  assert.notEqual(
    encodedIdentifier.primitiveParameters.visualConceptId,
    "encoded_bit_register",
  );
  assert.doesNotMatch(
    primitives.semanticSentencePrimitiveMarkup(
      encodedIdentifier,
      encodedIdentifierPlan.sentences.indexOf(encodedIdentifier),
    ),
    /data-declared-bit-count|data-bit-index|BIT FIELD|TEN BITS/,
  );

  const competingQuantityRaw = readRaw("002_gps_week_rollover");
  competingQuantityRaw.script.beats[1].spokenText =
    "A twenty-year message stores ten bits.";
  const competingQuantityPlan = buildAdversarialPlan(
    competingQuantityRaw,
    "encoded-bits-prefer-bit-quantity",
  );
  const competingQuantity = competingQuantityPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("twenty-year message"),
  );
  assert.ok(competingQuantity);
  assert.equal(
    competingQuantity.primitiveParameters.visualConceptId,
    "encoded_bit_register",
  );
  assert.equal(competingQuantity.primitiveParameters.quantity.value, "ten");
  assert.equal(competingQuantity.primitiveParameters.quantity.unit, "bits");

  const receivedUpdatesRaw = readRaw("002_gps_week_rollover");
  receivedUpdatesRaw.script.beats[2].spokenText =
    "The receivers received software updates to reduce battery drain.";
  const receivedUpdatesPlan = buildAdversarialPlan(
    receivedUpdatesRaw,
    "gps-completed-update-is-not-required",
  );
  const receivedUpdates = receivedUpdatesPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("reduce battery drain"),
  );
  assert.ok(receivedUpdates);
  assert.notEqual(
    receivedUpdates.primitiveParameters.visualConceptId,
    "receiver_patch_required",
  );
  assert.doesNotMatch(
    primitives.semanticSentencePrimitiveMarkup(
      receivedUpdates,
      receivedUpdatesPlan.sentences.indexOf(receivedUpdates),
    ),
    /AMBIGUITY|UPDATE REQUIRED|SOFTWARE PATCH/,
  );

  const wrongLocationRaw = readRaw("002_gps_week_rollover");
  wrongLocationRaw.script.beats[0].spokenText =
    "The GPS receiver showed the wrong location after startup.";
  const wrongLocationPlan = buildAdversarialPlan(
    wrongLocationRaw,
    "gps-wrong-location-is-not-date-error",
  );
  const wrongLocation = wrongLocationPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("wrong location"),
  );
  assert.ok(wrongLocation);
  assert.equal(
    wrongLocation.primitiveParameters.visualConceptId,
    "source_misinterpretation",
  );
  assert.doesNotMatch(
    primitives.semanticSentencePrimitiveMarkup(
      wrongLocation,
      wrongLocationPlan.sentences.indexOf(wrongLocation),
    ),
    /CLOCK ANOMALY|DATE ERROR|TIME ERROR|WRONG DATE/,
  );

  const repeatedAlarmRaw = structuredClone(nonGpsTemporalBase);
  repeatedAlarmRaw.script.beats[0].spokenText =
    "The alarm repeated every night, while the clock continued normally.";
  const repeatedAlarmPlan = buildAdversarialPlan(
    repeatedAlarmRaw,
    "non-gps-repeated-alarm-guard",
  );
  const repeatedAlarm = repeatedAlarmPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("alarm repeated every night"),
  );
  assert.ok(repeatedAlarm);
  assert.equal(
    repeatedAlarm.primitiveParameters.visualConceptId,
    "semantic_record_recurrence",
  );
  assert.notEqual(
    repeatedAlarm.primitiveParameters.visualConceptId,
    "finite_counter_wrap",
  );
  assert.doesNotMatch(
    primitives.semanticSentencePrimitiveMarkup(
      repeatedAlarm,
      repeatedAlarmPlan.sentences.indexOf(repeatedAlarm),
    ),
    /LAST VALUE|RESET TO|finite_counter_wrap/,
  );

  const backupCapacityRaw = structuredClone(nonGpsTemporalBase);
  backupCapacityRaw.script.beats[3].spokenText =
    "The backup counter has more capacity than the primary counter, but both clocks use the same oscillator.";
  const backupCapacityPlan = buildAdversarialPlan(
    backupCapacityRaw,
    "non-gps-capacity-comparison-guard",
  );
  const backupCapacity = backupCapacityPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("more capacity"),
  );
  assert.ok(backupCapacity);
  assert.equal(
    backupCapacity.primitiveParameters.visualConceptId,
    "capacity_comparison",
  );
  assert.notEqual(
    backupCapacity.primitiveParameters.visualConceptId,
    "counter_capacity_comparison",
  );
  assert.doesNotMatch(
    primitives.semanticSentencePrimitiveMarkup(
      backupCapacity,
      backupCapacityPlan.sentences.indexOf(backupCapacity),
    ),
    />LEGACY<|>NEWER<|>MORE ROOM</,
  );

  const unrelatedGpsCases = [
    {
      salt: "gps-negation-is-not-time-negation",
      beatIndex: 0,
      spokenText: "GPS receivers did not acquire the signal after startup.",
      phrase: "not acquire",
      forbiddenConcept: "counter_not_time",
      forbiddenMarkup: /COUNTER|NOT TIME|counter_not_time/,
    },
    {
      salt: "gps-calculation-is-not-counter-mapping",
      beatIndex: 2,
      spokenText: "GPS positions are calculated through satellite timing.",
      phrase: "calculated through satellite timing",
      forbiddenConcept: "counter_mapping_mechanism",
      forbiddenMarkup: /LAST→0|RECEIVER RULE|counter_mapping_mechanism/,
    },
    {
      salt: "gps-indoor-coverage-is-not-counter-capacity",
      beatIndex: 1,
      spokenText: "The GPS signal has limited indoor coverage near concrete walls.",
      phrase: "limited indoor coverage",
      forbiddenConcept: "bounded_value_range",
      forbiddenMarkup: /VALUE RANGE|POSSIBLE VALUES|bounded_value_range/,
    },
    {
      salt: "gps-weekly-self-test-is-not-counter-wrap",
      beatIndex: 2,
      spokenText: "The GPS receiver repeated its self-test every week.",
      phrase: "repeated its self-test every week",
      forbiddenConcept: "finite_counter_wrap",
      forbiddenMarkup: /LAST VALUE|RESET TO|finite_counter_wrap/,
    },
    {
      salt: "gps-maintenance-year-is-not-rollover",
      beatIndex: 3,
      spokenText: "GPS maintenance is scheduled in 2038 by the operator.",
      phrase: "maintenance is scheduled in 2038",
      forbiddenConcept: "future_rollover_timeline",
      forbiddenMarkup: /future_rollover_timeline/,
    },
    {
      salt: "gps-rover-physical-roll-is-not-counter-wrap",
      beatIndex: 2,
      spokenText: "The GPS-equipped rover rolled over on the slope.",
      phrase: "rover rolled over on the slope",
      forbiddenConcept: "finite_counter_wrap",
      forbiddenMarkup: /LAST VALUE|RESET TO|finite_counter_wrap/,
    },
    {
      salt: "gps-future-rover-roll-is-not-counter-rollover",
      beatIndex: 3,
      spokenText: "The GPS rover will roll over on the test slope in 2038.",
      phrase: "rover will roll over",
      forbiddenConcept: "future_rollover_timeline",
      forbiddenMarkup: /future_rollover_timeline/,
    },
    {
      salt: "gps-antenna-is-not-counter-mapping",
      beatIndex: 4,
      spokenText: "The GPS antenna mechanism was ordinary.",
      phrase: "antenna mechanism was ordinary",
      forbiddenConcept: "counter_mapping_mechanism",
      forbiddenMarkup: /LAST→0|RECEIVER RULE|counter_mapping_mechanism/,
    },
    {
      salt: "gps-future-counter-cannot-rebind-antenna",
      beatIndex: 4,
      spokenText: "The GPS antenna mechanism was ordinary. The week counter reset afterward.",
      phrase: "antenna mechanism was ordinary",
      forbiddenConcept: "counter_mapping_mechanism",
      forbiddenMarkup: /LAST→0|RECEIVER RULE|counter_mapping_mechanism/,
    },
    {
      salt: "gps-reception-range-is-not-counter-capacity",
      beatIndex: 3,
      spokenText: "Newer GPS receivers have more range outdoors than legacy receivers.",
      phrase: "more range outdoors",
      forbiddenConcept: "counter_capacity_comparison",
      forbiddenMarkup: />LEGACY<|>NEWER<|>MORE ROOM|counter_capacity_comparison/,
    },
    {
      salt: "gps-cabinet-room-is-not-counter-capacity",
      beatIndex: 3,
      spokenText: "The week counter sat beside a cabinet with more room.",
      phrase: "cabinet with more room",
      forbiddenConcept: "counter_capacity_comparison",
      forbiddenMarkup: />LEGACY<|>NEWER<|>MORE ROOM|counter_capacity_comparison/,
    },
    {
      salt: "gps-editor-room-is-not-counter-capacity",
      beatIndex: 3,
      spokenText: "The editor needed more room near the week counter.",
      phrase: "editor needed more room",
      forbiddenConcept: "counter_capacity_comparison",
      forbiddenMarkup: />LEGACY<|>NEWER<|>MORE ROOM|counter_capacity_comparison/,
    },
    {
      salt: "gps-initialization-time-is-not-counter-time",
      beatIndex: 0,
      spokenText: "The receiver did not have time to initialize before the GPS signal arrived.",
      phrase: "not have time to initialize",
      forbiddenConcept: "counter_not_time",
      forbiddenMarkup: /COUNTER|NOT TIME|counter_not_time/,
    },
    {
      salt: "gps-finite-battery-is-not-counter-range",
      beatIndex: 1,
      spokenText: "The receiver battery has a finite life.",
      phrase: "battery has a finite life",
      forbiddenConcept: "bounded_value_range",
      forbiddenMarkup: /FINITE VALUE SPACE|POSSIBLE VALUES|bounded_value_range/,
    },
    {
      salt: "gps-finite-battery-capacity-is-not-counter-range",
      beatIndex: 1,
      spokenText: "The receiver battery has finite capacity.",
      phrase: "battery has finite capacity",
      forbiddenConcept: "bounded_value_range",
      forbiddenMarkup: /FINITE VALUE SPACE|POSSIBLE VALUES|bounded_value_range/,
    },
    {
      salt: "gps-fixed-set-piece-is-not-counter-range",
      beatIndex: 1,
      spokenText: "The fixed set piece remained on the stage.",
      phrase: "fixed set piece",
      forbiddenConcept: "bounded_value_range",
      forbiddenMarkup: /FINITE VALUE SPACE|POSSIBLE VALUES|bounded_value_range/,
    },
    {
      salt: "gps-limited-ruins-field-is-not-counter-range",
      beatIndex: 1,
      spokenText: "The limited field of ruins remained unexplored.",
      phrase: "limited field of ruins",
      forbiddenConcept: "bounded_value_range",
      forbiddenMarkup: /FINITE VALUE SPACE|POSSIBLE VALUES|bounded_value_range/,
    },
    {
      salt: "gps-glass-bits-are-not-bit-register",
      beatIndex: 1,
      spokenText: "The excavation field contained bits of glass.",
      phrase: "field contained bits of glass",
      forbiddenConcept: "encoded_bit_register",
      forbiddenMarkup: /BIT FIELD|TEN BITS|encoded_bit_register/,
    },
    {
      salt: "gps-hardware-store-is-not-bit-register",
      beatIndex: 1,
      spokenText: "The hardware store stores drill bits.",
      phrase: "hardware store stores drill bits",
      forbiddenConcept: "encoded_bit_register",
      forbiddenMarkup: /BIT FIELD|TEN BITS|encoded_bit_register/,
    },
    {
      salt: "gps-advice-bits-are-not-bit-register",
      beatIndex: 1,
      spokenText: "Her message contains bits of advice for the receiver.",
      phrase: "message contains bits of advice",
      forbiddenConcept: "encoded_bit_register",
      forbiddenMarkup: /BIT FIELD|TEN BITS|encoded_bit_register/,
    },
    {
      salt: "gps-static-bits-are-not-bit-register",
      beatIndex: 1,
      spokenText: "The signal contains bits of static and noise.",
      phrase: "signal contains bits of static",
      forbiddenConcept: "encoded_bit_register",
      forbiddenMarkup: /BIT FIELD|TEN BITS|encoded_bit_register/,
    },
    {
      salt: "gps-a-bit-better-is-not-bit-register",
      beatIndex: 1,
      spokenText: "The new message encoding works a bit better.",
      phrase: "encoding works a bit better",
      forbiddenConcept: "encoded_bit_register",
      forbiddenMarkup: /BIT FIELD|TEN BITS|encoded_bit_register/,
    },
    {
      salt: "gps-a-little-bit-better-is-not-bit-register",
      beatIndex: 1,
      spokenText: "The new message encoding works a little bit better.",
      phrase: "encoding works a little bit better",
      forbiddenConcept: "encoded_bit_register",
      forbiddenMarkup: /BIT FIELD|TEN BITS|encoded_bit_register/,
    },
    {
      salt: "gps-bits-and-pieces-are-not-bit-register",
      beatIndex: 1,
      spokenText: "The message encoding uses bits and pieces from older drafts.",
      phrase: "encoding uses bits and pieces",
      forbiddenConcept: "encoded_bit_register",
      forbiddenMarkup: /BIT FIELD|TEN BITS|encoded_bit_register/,
    },
    {
      salt: "gps-fixed-counter-does-not-inherit-rover-roll",
      beatIndex: 2,
      spokenText: "The week counter stayed fixed when the rover rolled over.",
      phrase: "week counter stayed fixed",
      forbiddenConcept: "finite_counter_wrap",
      forbiddenMarkup: /LAST VALUE|RESET TO|finite_counter_wrap/,
    },
    {
      salt: "gps-future-rover-near-counter-is-not-counter-rollover",
      beatIndex: 3,
      spokenText: "In 2038, the rover will roll over beside the week counter.",
      phrase: "rover will roll over",
      forbiddenConcept: "future_rollover_timeline",
      forbiddenMarkup: /future_rollover_timeline/,
    },
    {
      salt: "gps-antenna-beside-counter-is-not-mapping",
      beatIndex: 4,
      spokenText: "The week counter sat beside an ordinary antenna mechanism.",
      phrase: "ordinary antenna mechanism",
      forbiddenConcept: "counter_mapping_mechanism",
      forbiddenMarkup: /LAST→0|RECEIVER RULE|counter_mapping_mechanism/,
    },
    {
      salt: "gps-receiver-manual-typography-fix-is-not-remediation",
      beatIndex: 2,
      spokenText: "The receiver manual mentioned counter ambiguity and needed software fixes for its typography.",
      phrase: "needed software fixes for its typography",
      forbiddenConcept: "receiver_patch_required",
      forbiddenMarkup: /data-cause-concept="software_patch"|>SOFTWARE PATCH<|receiver_patch_required/,
    },
    {
      salt: "gps-newspaper-date-is-not-receiver-error",
      beatIndex: 0,
      spokenText: "The receiver sat beside a newspaper with the wrong date.",
      phrase: "newspaper with the wrong date",
      forbiddenConcept: "counter_date_misinterpretation",
      forbiddenMarkup: />GPS VALUE<|>RECEIVER RULE<|counter_date_misinterpretation/,
    },
    {
      salt: "gps-editor-concern-is-not-counter-time",
      beatIndex: 4,
      spokenText: "The editor's concern was not time itself, but the budget.",
      phrase: "not time itself",
      forbiddenConcept: "counter_not_time",
      forbiddenMarkup: /NUMBER RESETS|TIME CONTINUES|counter_not_time/,
    },
    {
      salt: "gps-engineer-room-is-not-counter-capacity",
      beatIndex: 3,
      spokenText: "Removing the old week counter gives engineers more room in the receiver.",
      phrase: "gives engineers more room",
      forbiddenConcept: "counter_capacity_comparison",
      forbiddenMarkup: />LEGACY<|>NEWER<|>MORE ROOM|counter_capacity_comparison/,
    },
    {
      salt: "gps-editor-diagram-is-not-counter-mapping",
      beatIndex: 4,
      spokenText: "The editor mapped the week counter on the diagram.",
      phrase: "mapped the week counter",
      forbiddenConcept: "counter_mapping_mechanism",
      forbiddenMarkup: /LAST→0|RECEIVER RULE|counter_mapping_mechanism/,
    },
    {
      salt: "gps-newspaper-owner-is-not-receiver-date-error",
      beatIndex: 0,
      spokenText: "The receiver reported that the newspaper had the wrong date.",
      phrase: "newspaper had the wrong date",
      forbiddenConcept: "counter_date_misinterpretation",
      forbiddenMarkup: />GPS VALUE<|>RECEIVER RULE<|counter_date_misinterpretation/,
    },
    {
      salt: "gps-editor-counter-is-not-receiver-remediation",
      beatIndex: 2,
      spokenText: "The receiver required software fixes for a counter in the editor's article.",
      phrase: "required software fixes",
      forbiddenConcept: "receiver_patch_required",
      forbiddenMarkup: /data-cause-concept="software_patch"|>SOFTWARE PATCH<|receiver_patch_required/,
    },
    {
      salt: "gps-reset-button-is-not-counter-wrap",
      beatIndex: 2,
      spokenText: "The week counter sat beside a reset button.",
      phrase: "reset button",
      forbiddenConcept: "finite_counter_wrap",
      forbiddenMarkup: /LAST VALUE|RESET TO|finite_counter_wrap/,
      expectedNeutral: true,
    },
    {
      salt: "gps-cabinet-finite-capacity-is-not-value-range",
      beatIndex: 1,
      spokenText: "The week counter sat beside a cabinet with finite capacity.",
      phrase: "cabinet with finite capacity",
      forbiddenConcept: "bounded_value_range",
      forbiddenMarkup: /FINITE VALUE SPACE|POSSIBLE VALUES|bounded_value_range/,
      expectedNeutral: true,
    },
    {
      salt: "gps-drill-bit-crate-is-not-bit-register",
      beatIndex: 1,
      spokenText: "The GPS receiver encoded a crate holding ten drill bits.",
      phrase: "ten drill bits",
      forbiddenConcept: "encoded_bit_register",
      forbiddenMarkup: /BIT FIELD|TEN BITS|encoded_bit_register/,
      expectedNeutral: true,
    },
    {
      salt: "gps-newspaper-show-is-not-receiver-date-error",
      beatIndex: 0,
      spokenText: "The receiver watched as the newspaper showed the wrong date.",
      phrase: "newspaper showed the wrong date",
      forbiddenConcept: "counter_date_misinterpretation",
      forbiddenMarkup: />GPS VALUE<|>RECEIVER RULE<|counter_date_misinterpretation/,
      expectedNeutral: true,
    },
    {
      salt: "gps-manual-typography-owner-is-not-remediation",
      beatIndex: 2,
      spokenText: "The receiver handled the ambiguity near its manual which needed software fixes for typography.",
      phrase: "manual which needed software fixes",
      forbiddenConcept: "receiver_patch_required",
      forbiddenMarkup: /data-cause-concept="software_patch"|>SOFTWARE PATCH<|receiver_patch_required/,
      expectedNeutral: true,
    },
    {
      salt: "gps-clock-capacity-is-not-legacy-newer-comparison",
      beatIndex: 3,
      spokenText: "The GPS counter has more capacity than the clock.",
      phrase: "more capacity than the clock",
      forbiddenConcept: "counter_capacity_comparison",
      forbiddenMarkup: />LEGACY<|>NEWER<|>MORE ROOM|counter_capacity_comparison/,
    },
    {
      salt: "gps-calendar-owner-is-not-receiver-date-error",
      beatIndex: 0,
      spokenText: "The receiver watched as the calendar showed the wrong date.",
      phrase: "calendar showed the wrong date",
      forbiddenConcept: "counter_date_misinterpretation",
      forbiddenMarkup: /data-cause-concept="wrong_date"|counter_date_misinterpretation/,
      expectedNeutral: true,
    },
    {
      salt: "gps-beside-mapping-mechanism-is-not-counter-mapping",
      beatIndex: 4,
      spokenText: "The counter sat beside a mapping mechanism.",
      phrase: "mapping mechanism",
      forbiddenConcept: "counter_mapping_mechanism",
      forbiddenMarkup: /data-cause-concept="counter_mapping_mechanism"/,
      expectedNeutral: true,
    },
    {
      salt: "gps-phone-number-is-not-counter-wrap",
      beatIndex: 2,
      spokenText: "The phone number reset itself.",
      phrase: "phone number reset itself",
      forbiddenConcept: "finite_counter_wrap",
      forbiddenMarkup: /data-finite-counter-concept="wrap"|finite_counter_wrap/,
      expectedNeutral: true,
    },
    {
      salt: "gps-capacity-battery-modifier-is-not-value-range",
      beatIndex: 1,
      spokenText: "The counter has a finite capacity battery.",
      phrase: "finite capacity battery",
      forbiddenConcept: "bounded_value_range",
      forbiddenMarkup: /FINITE VALUE SPACE|POSSIBLE VALUES|bounded_value_range/,
      expectedNeutral: true,
    },
    {
      salt: "gps-receiver-manual-is-not-patch-owner",
      beatIndex: 2,
      spokenText: "The receiver manual needed a software update for counter ambiguity.",
      phrase: "receiver manual needed",
      forbiddenConcept: "receiver_patch_required",
      forbiddenMarkup: /data-cause-concept="software_patch"|receiver_patch_required/,
      expectedNeutral: true,
    },
    {
      salt: "gps-transitive-reset-is-not-counter-wrap",
      beatIndex: 2,
      spokenText: "The GPS week counter reset the receiver display.",
      phrase: "reset the receiver display",
      forbiddenConcept: "finite_counter_wrap",
      forbiddenMarkup: /data-finite-counter-concept="wrap"|finite_counter_wrap/,
      expectedNeutral: true,
    },
    {
      salt: "gps-counter-stored-battery-is-not-value-range",
      beatIndex: 1,
      spokenText: "The GPS week counter stores a battery with finite capacity.",
      phrase: "battery with finite capacity",
      forbiddenConcept: "bounded_value_range",
      forbiddenMarkup: /FINITE VALUE SPACE|POSSIBLE VALUES|bounded_value_range/,
      expectedNeutral: true,
    },
    {
      salt: "gps-clock-owner-is-not-receiver-time-error",
      beatIndex: 0,
      spokenText: "The GPS receiver stood beside a clock that showed the wrong time.",
      phrase: "clock that showed the wrong time",
      forbiddenConcept: "counter_date_misinterpretation",
      forbiddenMarkup: /data-cause-concept="wrong_date"|counter_date_misinterpretation/,
      expectedNeutral: true,
    },
    {
      salt: "gps-remediation-without-receiver-is-generic",
      beatIndex: 2,
      spokenText: "Counter ambiguity needed software fixes.",
      phrase: "ambiguity needed software fixes",
      forbiddenConcept: "receiver_patch_required",
      forbiddenMarkup: /data-cause-concept="software_patch"|>SOFTWARE PATCH<|receiver_patch_required/,
    },
    {
      salt: "gps-editor-wrong-date-is-not-counter-error",
      beatIndex: 0,
      spokenText: "The report listed the wrong date because the editor mistyped it.",
      phrase: "report listed the wrong date",
      forbiddenConcept: "counter_date_misinterpretation",
      forbiddenMarkup: />GPS VALUE<|>RECEIVER RULE<|counter_date_misinterpretation/,
    },
    {
      salt: "gps-manual-values-are-not-counter-range",
      beatIndex: 1,
      spokenText: "The manual listed possible values for screen brightness.",
      phrase: "possible values for screen brightness",
      forbiddenConcept: "bounded_value_range",
      forbiddenMarkup: /FINITE VALUE SPACE|POSSIBLE VALUES|bounded_value_range/,
      expectedNeutral: true,
    },
    {
      salt: "gps-editor-mapping-is-not-receiver-mapping",
      beatIndex: 4,
      spokenText: "The GPS receiver watched as the editor mapped the counter to a chart.",
      phrase: "editor mapped the counter",
      forbiddenConcept: "counter_mapping_mechanism",
      forbiddenMarkup: /LAST→0|RECEIVER RULE|counter_mapping_mechanism/,
      expectedNeutral: true,
    },
    {
      salt: "gps-crate-label-is-not-bit-register",
      beatIndex: 1,
      spokenText: "The receiver stored a crate marked ten bits beside the counter.",
      phrase: "crate marked ten bits",
      forbiddenConcept: "encoded_bit_register",
      forbiddenMarkup: /BIT FIELD|TEN BITS|encoded_bit_register/,
      expectedNeutral: true,
    },
    {
      salt: "gps-transitive-change-is-not-counter-not-time",
      beatIndex: 4,
      spokenText: "The counter changed the display—not time itself.",
      phrase: "changed the display—not time",
      forbiddenConcept: "counter_not_time",
      forbiddenMarkup: /NUMBER RESETS|TIME CONTINUES|counter_not_time/,
    },
    {
      salt: "gps-page-room-is-not-counter-capacity",
      beatIndex: 3,
      spokenText: "Newer navigation messages give the week counter more room on the printed page.",
      phrase: "more room on the printed page",
      forbiddenConcept: "counter_capacity_comparison",
      forbiddenMarkup: /data-comparison-concept="capacity"|counter_capacity_comparison/,
    },
    {
      salt: "gps-called-office-is-not-quote",
      beatIndex: 2,
      spokenText: "The technician called the office after the reset.",
      phrase: "called the office",
      forbiddenConcept: "cue_evidence_quote",
      forbiddenMarkup: /data-evidence-variant="quote"|[“”]/,
      expectedNeutral: true,
    },
    {
      salt: "gps-water-flow-is-not-network",
      beatIndex: 4,
      spokenText: "Water flowed across the mechanism beneath the receiver.",
      phrase: "flowed across the mechanism",
      forbiddenConcept: "cue_evidence_network",
      forbiddenMarkup: /data-evidence-variant="network"/,
      expectedNeutral: true,
    },
    {
      salt: "gps-reset-alarm-is-not-counter-not-time",
      beatIndex: 4,
      spokenText: "The counter reset alarm was not time.",
      phrase: "reset alarm was not time",
      forbiddenConcept: "counter_not_time",
      forbiddenMarkup: /NUMBER RESETS|TIME CONTINUES|counter_not_time/,
    },
    {
      salt: "gps-wooden-log-is-not-document",
      beatIndex: 2,
      spokenText: "A wooden log blocked the narrow forest road.",
      phrase: "wooden log",
      forbiddenConcept: "cue_evidence_document",
      forbiddenMarkup: /data-evidence-variant="document"/,
      expectedNeutral: true,
    },
    {
      salt: "gps-musical-note-is-not-document",
      beatIndex: 2,
      spokenText: "The musician played a single note beneath the stage.",
      phrase: "single note",
      forbiddenConcept: "cue_evidence_document",
      forbiddenMarkup: /data-evidence-variant="document"/,
      expectedNeutral: true,
    },
    {
      salt: "gps-called-office-colon-is-not-quote",
      beatIndex: 2,
      spokenText: "The technician called the office: nobody answered.",
      phrase: "called the office",
      forbiddenConcept: "cue_evidence_quote",
      forbiddenMarkup: /data-evidence-variant="quote"|[“”]/,
      expectedNeutral: true,
    },
    {
      salt: "gps-physical-bits-are-not-register",
      beatIndex: 1,
      spokenText: "The device used ten bits to drill the panel.",
      phrase: "ten bits to drill",
      forbiddenConcept: "encoded_bit_register",
      forbiddenMarkup: /BIT FIELD|TEN BITS|encoded_bit_register/,
      expectedNeutral: true,
    },
    {
      salt: "gps-page-room-next-clause-is-not-counter-capacity",
      beatIndex: 3,
      spokenText: "Newer navigation messages give the week counter more room, but only on the printed page.",
      phrase: "week counter more room",
      forbiddenConcept: "counter_capacity_comparison",
      forbiddenMarkup: /data-comparison-concept="capacity"|counter_capacity_comparison/,
      expectedNeutral: true,
    },
    {
      salt: "gps-month-may-with-year-is-not-uncertainty",
      beatIndex: 0,
      spokenText: "In May 1999, engineers tested the GPS receiver.",
      phrase: "May 1999",
      forbiddenConcept: "bounded_uncertainty",
      forbiddenMarkup: /UNRESOLVED|bounded_uncertainty/,
    },
    {
      salt: "gps-month-may-with-day-is-not-uncertainty",
      beatIndex: 0,
      spokenText: "On May 4, 1999, engineers tested the GPS receiver.",
      phrase: "May 4",
      forbiddenConcept: "bounded_uncertainty",
      forbiddenMarkup: /UNRESOLVED|bounded_uncertainty/,
    },
    {
      salt: "gps-month-may-modifier-is-not-uncertainty",
      beatIndex: 0,
      spokenText: "The May 1999 test included the GPS receiver.",
      phrase: "May 1999",
      forbiddenConcept: "bounded_uncertainty",
      forbiddenMarkup: /UNRESOLVED|bounded_uncertainty/,
    },
    {
      salt: "gps-thought-experiment-is-not-assumption",
      beatIndex: 2,
      spokenText: "The thought experiment used a paper clock.",
      phrase: "thought experiment",
      forbiddenConcept: "reported_assumption",
      forbiddenMarkup: /UNRESOLVED|reported_assumption/,
      expectedNeutral: true,
    },
    {
      salt: "gps-assumed-name-is-not-assumption",
      beatIndex: 2,
      spokenText: "The engineer used an assumed name during the test.",
      phrase: "assumed name",
      forbiddenConcept: "reported_assumption",
      forbiddenMarkup: /UNRESOLVED|reported_assumption/,
      expectedNeutral: true,
    },
    {
      salt: "gps-believed-value-is-not-assumption",
      beatIndex: 2,
      spokenText: "The believed value appeared in the margin.",
      phrase: "believed value",
      forbiddenConcept: "reported_assumption",
      forbiddenMarkup: /UNRESOLVED|reported_assumption/,
      expectedNeutral: true,
    },
    {
      salt: "gps-time-efficient-is-not-counter-not-time",
      beatIndex: 4,
      spokenText: "The counter reset is not time-efficient.",
      phrase: "not time-efficient",
      forbiddenConcept: "counter_not_time",
      forbiddenMarkup: /NUMBER RESETS|TIME CONTINUES|counter_not_time/,
    },
    {
      salt: "gps-manual-lever-is-not-document",
      beatIndex: 2,
      spokenText: "The technician pulled a manual lever beside the receiver.",
      phrase: "manual lever",
      forbiddenConcept: "cue_evidence_document",
      forbiddenMarkup: /data-evidence-variant="document"/,
      expectedNeutral: true,
    },
    {
      salt: "gps-bits-tighten-is-not-register",
      beatIndex: 1,
      spokenText: "The device used ten bits to tighten the screws.",
      phrase: "ten bits to tighten",
      forbiddenConcept: "encoded_bit_register",
      forbiddenMarkup: /BIT FIELD|TEN BITS|encoded_bit_register/,
      expectedNeutral: true,
    },
    {
      salt: "gps-bits-toolbox-is-not-register",
      beatIndex: 1,
      spokenText: "The device stored ten bits in its toolbox.",
      phrase: "ten bits in its toolbox",
      forbiddenConcept: "encoded_bit_register",
      forbiddenMarkup: /BIT FIELD|TEN BITS|encoded_bit_register/,
      expectedNeutral: true,
    },
  ];
  for (const adversarial of unrelatedGpsCases) {
    const raw = readRaw("002_gps_week_rollover");
    raw.script.beats[adversarial.beatIndex].spokenText = adversarial.spokenText;
    const adversarialPlan = buildAdversarialPlan(raw, adversarial.salt);
    const sentence = adversarialPlan.sentences.find(
      (candidate) => candidate.wordSpan.text.includes(adversarial.phrase),
    );
    assert.ok(sentence, adversarial.salt);
    assert.notEqual(
      sentence.primitiveParameters.visualConceptId,
      adversarial.forbiddenConcept,
      adversarial.salt,
    );
    const markup = primitives.semanticSentencePrimitiveMarkup(
      sentence,
      adversarialPlan.sentences.indexOf(sentence),
    );
    const geometryMarkup = markup
      .replace(/<desc[^>]*>[\s\S]*?<\/desc>/, "")
      .replace(/<text id="semantic-concept-\d+"[^>]*>[\s\S]*?<\/text>/, "");
    assert.doesNotMatch(
      geometryMarkup,
      adversarial.forbiddenMarkup,
      adversarial.salt,
    );
    if (adversarial.expectedNeutral) {
      assert.match(
        sentence.primitiveParameters.visualConceptId,
        /^cue_evidence_(?:bands|document|field|focus|frame|network|quote|ribbon|spotlight)$/,
        adversarial.salt,
      );
      assert.equal(sentence.capability.assetId, "archive_record");
      assert.equal(sentence.capability.grammarId, "evidence_inspection");
      assert.match(markup, /data-evidence-variant=/, adversarial.salt);
    }
  }

  assert.equal(
    semanticBoundedValueRangeClaimMatches(
      "The manual listed possible values for screen brightness.",
    ),
    false,
  );
  assert.equal(
    semanticCounterMappingClaimMatches(
      "The GPS receiver watched as the editor mapped the counter to a chart.",
    ),
    false,
  );
  assert.equal(
    semanticEncodedBitClaimMatches(
      "The receiver stored a crate marked ten bits beside the counter.",
    ),
    false,
  );
  assert.equal(
    semanticBoundedValueRangeClaimMatches(
      "leaving only a limited set of possible values.",
    ),
    true,
  );
  assert.equal(
    semanticCounterMappingClaimMatches(
      "The receiver interpreted the week counter as zero.",
    ),
    true,
  );
  assert.equal(
    semanticEncodedBitClaimMatches(
      "The legacy civil signal stores its week number in ten bits.",
    ),
    true,
  );
  assert.equal(
    semanticCounterNotTimeClaimMatches(
      "The counter changed the display—not time itself.",
    ),
    false,
  );
  assert.equal(
    semanticCounterCapacityComparisonClaimMatches(
      "Newer navigation messages give the week counter more room on the printed page.",
    ),
    false,
  );
  assert.equal(
    semanticNeutralQuoteCueMatches(
      "The technician called the office after the reset.",
    ),
    false,
  );
  assert.equal(
    semanticNeutralNetworkCueMatches(
      "Water flowed across the mechanism beneath the receiver.",
    ),
    false,
  );
  assert.equal(
    semanticCounterNotTimeClaimMatches(
      "The counter reset alarm was not time.",
    ),
    false,
  );
  assert.equal(
    semanticNeutralDocumentCueMatches(
      "A wooden log blocked the narrow forest road.",
    ),
    false,
  );
  assert.equal(
    semanticNeutralDocumentCueMatches(
      "The musician played a single note beneath the stage.",
    ),
    false,
  );
  assert.equal(
    semanticNeutralQuoteCueMatches(
      "The technician called the office: nobody answered.",
    ),
    false,
  );
  assert.equal(
    semanticEncodedBitClaimMatches(
      "The device used ten bits to drill the panel.",
    ),
    false,
  );
  assert.equal(
    semanticCounterCapacityComparisonClaimMatches(
      "Newer navigation messages give the week counter more room,",
    ),
    false,
  );
  assert.equal(
    semanticCounterNotTimeClaimMatches(
      "The counter reset is not time-efficient.",
    ),
    false,
  );
  assert.equal(
    semanticNeutralDocumentCueMatches(
      "The technician pulled a manual lever beside the receiver.",
    ),
    false,
  );
  assert.equal(
    semanticEncodedBitClaimMatches(
      "The device used ten bits to tighten the screws.",
    ),
    false,
  );
  assert.equal(
    semanticEncodedBitClaimMatches(
      "The device stored ten bits in its toolbox.",
    ),
    false,
  );

  for (const [salt, spokenText, phrase] of [
    [
      "radio-repeat-button-is-not-signal-recurrence",
      "No repeat button was installed on the radio receiver.",
      "repeat button",
    ],
    [
      "radio-repeated-pattern-is-not-signal-recurrence",
      "The archive contained no repeated pattern on the paper chart.",
      "repeated pattern",
    ],
  ]) {
    const raw = readRaw("001_wow_signal_mystery");
    raw.script.beats[3].spokenText = spokenText;
    const plan = buildAdversarialPlan(raw, salt);
    const sentence = plan.sentences.find(
      (candidate) => candidate.wordSpan.text.includes(phrase),
    );
    assert.ok(sentence, salt);
    assert.match(
      sentence.primitiveParameters.visualConceptId,
      /^cue_evidence_(?:bands|document|field|focus|frame|network|quote|ribbon|spotlight)$/,
      salt,
    );
    assert.notEqual(
      sentence.primitiveParameters.visualConceptId,
      "signal_nonrecurrence",
      salt,
    );
    assert.equal(sentence.visualIntent.predicate, "appearance", salt);
  }
  const missingProofRaw = readRaw("001_wow_signal_mystery");
  missingProofRaw.script.beats[3].spokenText =
    "The candidate left no repeatable proof.";
  const missingProofPlan = buildAdversarialPlan(
    missingProofRaw,
    "radio-missing-repeatable-proof",
  );
  const missingProofSentence = missingProofPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("repeatable proof"),
  );
  assert.ok(missingProofSentence);
  assert.equal(
    missingProofSentence.primitiveParameters.visualConceptId,
    "missing_confirmation",
  );
  const actualRadioPlan = buildAdversarialPlan(
    readRaw("001_wow_signal_mystery"),
    "radio-signal-nonrecurrence-positive",
  );
  const actualSignalNonrecurrence = actualRadioPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("same signal again"),
  );
  assert.ok(actualSignalNonrecurrence);
  assert.equal(
    actualSignalNonrecurrence.primitiveParameters.visualConceptId,
    "signal_nonrecurrence",
  );
  for (const [salt, spokenText, phrase] of [
    [
      "causal-year-precedes-chronology",
      "In 2019, heavy rain caused a launch delay.",
      "rain caused a launch delay",
    ],
    [
      "causal-duration-precedes-number",
      "After 20 years, heavy rain caused a launch delay.",
      "rain caused a launch delay",
    ],
  ]) {
    const raw = readRaw("002_gps_week_rollover");
    raw.script.beats[2].spokenText = spokenText;
    const causalPlan = buildAdversarialPlan(raw, salt);
    const causalSentence = causalPlan.sentences.find(
      (candidate) => candidate.wordSpan.text.includes(phrase),
    );
    assert.ok(causalSentence, salt);
    assert.equal(
      causalSentence.primitiveParameters.visualConceptId,
      "mapping_cause_effect",
      salt,
    );
    assert.equal(causalSentence.visualIntent.predicate, "cause_effect", salt);
  }

  const makingNotesRaw = readRaw("002_gps_week_rollover");
  makingNotesRaw.script.beats[2].spokenText =
    "In 2019, an engineer was making notes during the inspection.";
  const makingNotesPlan = buildAdversarialPlan(
    makingNotesRaw,
    "making-notes-is-not-causation",
  );
  const makingNotes = makingNotesPlan.sentences.find(
    (candidate) => candidate.wordSpan.text.includes("making notes"),
  );
  assert.ok(makingNotes);
  assert.notEqual(
    makingNotes.primitiveParameters.visualConceptId,
    "mapping_cause_effect",
  );
  assert.notEqual(makingNotes.visualIntent.predicate, "cause_effect");

  const pluralDatesRaw = readRaw("002_gps_week_rollover");
  pluralDatesRaw.script.beats[0].spokenText =
    "Some legacy GPS receivers interpreted the counter incorrectly and showed incorrect dates.";
  const pluralDatesPlan = buildAdversarialPlan(
    pluralDatesRaw,
    "gps-incorrect-dates-positive",
  );
  const pluralDates = pluralDatesPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("incorrect dates"),
  );
  assert.ok(pluralDates);
  assert.equal(
    pluralDates.primitiveParameters.visualConceptId,
    "counter_date_misinterpretation",
  );
  assert.match(
    primitives.semanticSentencePrimitiveMarkup(
      pluralDates,
      pluralDatesPlan.sentences.indexOf(pluralDates),
    ),
    /WRONG DATE/,
  );

  const realBaychimo = buildAdversarialPlan(
    readRaw("003_baychimo_icebound_drift"),
    "baychimo-clause-local-semantics",
  );
  const archivedDecadesLater = realBaychimo.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("decades after"),
  );
  assert.ok(archivedDecadesLater);
  assert.equal(archivedDecadesLater.capability.grammarId, "chronology_accumulation");
  assert.equal(archivedDecadesLater.capability.assetId, "timeline_axis");
  assert.notEqual(
    archivedDecadesLater.primitiveParameters.visualConceptId,
    "semantic_vessel_movement",
  );
  const reportedAssumption = realBaychimo.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("assumed it had sunk"),
  );
  assert.equal(
    reportedAssumption?.primitiveParameters.visualConceptId,
    "reported_assumption",
  );
  const witnessSighting = realBaychimo.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("hunters soon spotted"),
  );
  assert.equal(
    witnessSighting?.primitiveParameters.visualConceptId,
    "witness_sighting",
  );
});

test("StoryIR segments partition every aligned word exactly once within renderer limits", () => {
  for (const [id] of CASES) {
    const { storyIR, timingContext, visualIntentGraph } = build(id);
    let totalSegments = 0;
    for (const [beatIndex, beat] of storyIR.beats.entries()) {
      const timingBeat = timingContext.beats[beatIndex];
      assert.equal(beat.beatId, timingBeat.beatId);
      assert.equal(beat.segments[0].startWordIndex, timingBeat.wordStartIndex);
      assert.equal(beat.segments.at(-1).endWordIndex, timingBeat.wordEndIndex);
      let nextWordIndex = timingBeat.wordStartIndex;
      for (const segment of beat.segments) {
        assert.equal(segment.startWordIndex, nextWordIndex);
        assert.ok(segment.text.length <= MAX_SEGMENT_CHARACTERS);
        const exactWords = timingContext.words
          .slice(segment.startWordIndex, segment.endWordIndex);
        assert.equal(segment.text, exactWords.map((word) => word.text).join(" "));
        assert.equal(segment.startFrame, exactWords[0].startFrame);
        assert.equal(segment.endFrame, exactWords.at(-1).endFrame);
        assert.equal(
          segment.endWordIndex - segment.startWordIndex,
          segment.text.split(/\s+/).length,
        );
        nextWordIndex = segment.endWordIndex;
        totalSegments += 1;
      }
      assert.equal(nextWordIndex, timingBeat.wordEndIndex);
    }
    assert.equal(visualIntentGraph.intents.length, totalSegments);
    assert.ok(totalSegments >= 5 && totalSegments <= 20);
    assert.deepEqual(
      visualIntentGraph.intents.map((intent) => intent.wordSpan),
      storyIR.beats.flatMap((beat) => beat.segments),
    );
  }
});

test("semantic-v3 compiles and renders non-registry narration deterministically", async () => {
  const { compileAnimationIRToHtml } = await import(
    "../renderer/hyperframes/animation-ir-adapter.mjs"
  );
  const manifestHashes = new Set();
  const irHashes = new Set();
  const compositionHashes = new Set();
  for (const [id] of CASES) {
    const { draft, timingContext, visualIntentGraph } = build(id);
    assert.equal(findSemanticEventProfile({
      profileId: SEMANTIC_SENTENCE_PROFILE_ID,
      draftHash: draft.contentHash,
      alignmentHash: timingContext.alignmentHash,
    }), null);
    const input = {
      animationProfile: "semantic-v3",
      projectId: `prj_generic_${id}`,
      projectRevision: 1,
      renderProfile: "preview",
      draft,
      timingContext,
    };
    const compiled = compileProductionAnimation(input);
    const repeated = compileProductionAnimation(structuredClone(input));
    const preplanned = compileProductionAnimation({
      ...structuredClone(input),
      semanticAnimationSceneDslPlan: structuredClone(
        compiled.plan.content.semanticAnimationSceneDslPlan,
      ),
    });
    assert.equal(repeated.plan.contentHash, compiled.plan.contentHash);
    assert.equal(repeated.animationIR.contentHash, compiled.animationIR.contentHash);
    assert.equal(
      preplanned.animationIR.contentHash,
      compiled.animationIR.contentHash,
    );
    if (id === CASES[0][0]) {
      const defaultScenePlan =
        compiled.plan.content.semanticAnimationSceneDslPlan;
      const providerSceneByProposition = new Map(
        defaultScenePlan.scenes.map(
          (scene) => [scene.propositionId, scene.sceneDsl],
        ),
      );
      const asyncScenePlan = await planSemanticAnimationScenes({
        semanticEventGraph:
          compiled.plan.content.semanticEventGraph,
        semanticVisualSentencePlan:
          compiled.plan.content.semanticVisualSentencePlan,
        planner: {
          id: "integration_scene_planner",
          mode: "mock",
          health() {
            return {
              mode: "mock",
              promptProfileId:
                "dark_curiosity_local_scene_planner_prompt_v1",
            };
          },
          async planScene({ propositionId }) {
            return {
              providerId: "integration_scene_provider",
              modelId: "integration-scene-model-v1",
              promptProfileId:
                "dark_curiosity_local_scene_planner_prompt_v1",
              fallbackUsed: false,
              failure: null,
              sceneDsl:
                providerSceneByProposition.get(propositionId),
            };
          },
        },
      });
      const providerCompiled = compileProductionAnimation({
        ...structuredClone(input),
        semanticAnimationSceneDslPlan: asyncScenePlan,
      });
      assert.notEqual(
        providerCompiled.animationIR.contentHash,
        compiled.animationIR.contentHash,
      );
      assert.equal(
        providerCompiled.plan.content.semanticAnimationSceneDslPlan
          .contentHash,
        asyncScenePlan.contentHash,
      );
      const tamperedScenePlan = structuredClone(asyncScenePlan);
      tamperedScenePlan.scenes[0].provenance.modelId =
        "tampered-model";
      assert.throws(
        () => compileProductionAnimation({
          ...structuredClone(input),
          semanticAnimationSceneDslPlan: tamperedScenePlan,
        }),
        { code: "ANIMATION_SCENE_DSL_PLAN_INVALID" },
      );
    }
    assert.equal(compiled.animationIR.schemaVersion, 3);
    assert.equal(
      compiled.animationIR.content.semantic.profileId,
      SEMANTIC_SENTENCE_PROFILE_ID,
    );
    assert.equal(
      compiled.animationIR.content.semantic.semanticEventGraphHash,
      compiled.animationIR.content.semanticEventGraph.contentHash,
    );
    assert.equal(
      compiled.animationIR.content.semanticVisualSentencePlan.sentences.length,
      visualIntentGraph.intents.length,
    );
    const sceneDslPlan =
      compiled.animationIR.content.semanticAnimationSceneDslPlan;
    assert.ok(sceneDslPlan);
    assert.equal(
      compiled.animationIR.content.semantic.semanticAnimationSceneDslPlanHash,
      sceneDslPlan.contentHash,
    );
    assert.equal(
      sceneDslPlan.scenes.length,
      compiled.animationIR.content.semanticVisualSentencePlan.sentences.length,
    );
    assert.deepEqual(
      sceneDslPlan.scenes.map((scene) => scene.propositionId),
      compiled.animationIR.content.semanticVisualSentencePlan.sentences
        .map((sentence) => sentence.propositionId),
    );
    const composition = compileAnimationIRToHtml(compiled.animationIR, {
      semanticSourceContext: { draft, timingContext },
    });
    assert.match(composition.compositionHash, /^[a-f0-9]{64}$/);
    assert.match(composition.html, /data-semantic-profile-id=/);
    for (const sentence of compiled.animationIR.content.semanticVisualSentencePlan.sentences) {
      assert.ok(
        SEMANTIC_SENTENCE_RENDERER_GRAMMAR_ASSET_BINDINGS[
          sentence.capability.grammarId
        ].includes(sentence.capability.assetId),
      );
    }
    manifestHashes.add(compiled.plan.assetManifestHash);
    irHashes.add(compiled.animationIR.contentHash);
    compositionHashes.add(composition.compositionHash);
  }
  assert.equal(manifestHashes.size, CASES.length);
  assert.equal(irHashes.size, CASES.length);
  assert.equal(compositionHashes.size, CASES.length);
});

test("simple presenter binds Scene DSL provenance but enforces one motion channel", async () => {
  const { compileAnimationIRToHtml } = await import(
    "../renderer/hyperframes/animation-ir-adapter.mjs"
  );
  const value = compileRaw(
    readRaw("001_wow_signal_mystery"),
    "scene-action-renderer",
    "prj_scene_action_renderer",
  );
  const defaultPlan =
    value.compiled.animationIR.content.semanticAnimationSceneDslPlan;
  const alternatePlan = alternateSceneDslPlan(value.compiled);
  const alternate = compileProductionAnimation({
    animationProfile: "semantic-v3",
    projectId: "prj_scene_action_renderer",
    projectRevision: 1,
    renderProfile: "preview",
    draft: value.draft,
    timingContext: value.timingContext,
    semanticAnimationSceneDslPlan: alternatePlan,
  });
  const defaultComposition = compileAnimationIRToHtml(
    value.compiled.animationIR,
    rendererSourceOptions(value),
  );
  const alternateComposition = compileAnimationIRToHtml(
    alternate.animationIR,
    rendererSourceOptions(value),
  );
  assert.notEqual(alternatePlan.contentHash, defaultPlan.contentHash);
  assert.notEqual(
    alternate.animationIR.contentHash,
    value.compiled.animationIR.contentHash,
  );
  assert.notEqual(
    alternateComposition.compositionHash,
    defaultComposition.compositionHash,
  );
  assert.equal(
    alternateComposition.profile.sceneDslPlanHash,
    alternatePlan.contentHash,
  );
  assert.match(
    alternateComposition.html,
    new RegExp(`data-semantic-scene-dsl-plan-hash="${
      alternatePlan.contentHash
    }"`),
  );
  assert.doesNotMatch(
    alternateComposition.html,
    /highlight:module_primary:develop:pulse_once/,
  );
  assert.doesNotMatch(
    alternateComposition.html,
    /camera:scene:resolve:pull_overview/,
  );
  assert.match(
    alternateComposition.html,
    /create:module_primary:entry:reveal/,
  );
  assert.match(
    alternateComposition.html,
    /semanticSceneActionStateAtFrame/,
  );
  assert.match(
    alternateComposition.html,
    /activeSceneActionSignatures/,
  );
  assert.match(
    alternateComposition.html,
    /semanticTransitionProgress/,
  );
  assert.match(
    alternateComposition.html,
    /routeDisplacement/,
  );
  assert.match(
    alternateComposition.html,
    /route\.getPointAtLength\(length\*routeActionProgress\)/,
  );
  assert.match(
    alternateComposition.html,
    /invalid_scene_action_target_count/,
  );
  const providerId = alternatePlan.scenes[0].provenance.providerId;
  const modelId = alternatePlan.scenes[0].provenance.modelId;
  assert.equal(alternateComposition.html.includes(providerId), false);
  assert.equal(alternateComposition.html.includes(modelId), false);
  assert.equal(alternateComposition.html.includes("fallbackUsed"), false);

  const missingPlan = structuredClone(value.compiled.animationIR);
  delete missingPlan.content.semanticAnimationSceneDslPlan;
  delete missingPlan.content.semantic.semanticAnimationSceneDslPlanHash;
  assert.throws(
    () => compileAnimationIRToHtml(
      missingPlan,
      rendererSourceOptions(value),
    ),
    /requires a Scene DSL plan/,
  );

  const staleHash = structuredClone(value.compiled.animationIR);
  staleHash.content.semantic.semanticAnimationSceneDslPlanHash =
    "d".repeat(64);
  assert.throws(
    () => compileAnimationIRToHtml(staleHash, rendererSourceOptions(value)),
    /hash does not match semantic content/,
  );

  const reorderedPlan = buildSemanticAnimationSceneDslPlanFromScenes({
    bindings: defaultPlan.bindings,
    planner: defaultPlan.planner,
    scenes: [
      defaultPlan.scenes[1],
      defaultPlan.scenes[0],
      ...defaultPlan.scenes.slice(2),
    ],
  });
  const reordered = structuredClone(value.compiled.animationIR);
  reordered.content.semanticAnimationSceneDslPlan = reorderedPlan;
  reordered.content.semantic.semanticAnimationSceneDslPlanHash =
    reorderedPlan.contentHash;
  assert.throws(
    () => compileAnimationIRToHtml(reordered, rendererSourceOptions(value)),
    /not grounded in the semantic sentence plan/,
  );
});

test("semantic clauses preserve negation and do not erase Baychimo vessel movement", () => {
  const wow = build("001_wow_signal_mystery");
  const gps = build("002_gps_week_rollover");
  const baychimo = build("003_baychimo_icebound_drift");
  for (const graph of [wow.visualIntentGraph, gps.visualIntentGraph]) {
    assert.ok(graph.intents.some((intent) => (
      intent.role === "payoff"
      && intent.visualIntent.predicate === "negation"
      && intent.polarity === "negated"
    )));
  }
  const baychimoEvidence = baychimo.visualIntentGraph.intents.filter(
    (intent) => intent.role === "evidence",
  );
  assert.ok(baychimoEvidence.some(
    (intent) => intent.visualIntent.predicate === "movement",
  ));
  assert.ok(baychimoEvidence.every(
    (intent) => intent.visualIntent.predicate !== "disappearance",
  ));
});

test("leading narration silence remains exact and renders from frame zero safely", async () => {
  const { compileAnimationIRToHtml } = await import(
    "../renderer/hyperframes/animation-ir-adapter.mjs"
  );
  const draft = normalizeDraftBundle(readRaw("001_wow_signal_mystery"));
  const timingContext = timingFor(draft, "leading-silence", 16, 5);
  const compiled = compileProductionAnimation({
    animationProfile: "semantic-v3",
    projectId: "prj_generic_leading_silence",
    projectRevision: 1,
    renderProfile: "preview",
    draft,
    timingContext,
  });
  assert.equal(
    compiled.animationIR.content.semanticVisualSentencePlan.sentences[0]
      .wordSpan.startFrame,
    5,
  );
  const composition = compileAnimationIRToHtml(compiled.animationIR, {
    semanticSourceContext: { draft, timingContext },
  });
  assert.match(composition.html, /"startFrame":5/);
});

test("StoryIR segments to the renderer line budget before compilation", async () => {
  const {
    compileAnimationIRToHtml,
  } = await import("../renderer/hyperframes/animation-ir-adapter.mjs");
  const {
    semanticSentenceTextLines,
  } = await import("../renderer/hyperframes/primitives/semantic-sentence-primitives.mjs");
  const raw = readRaw("001_wow_signal_mystery");
  raw.script.beats[1].spokenText = Array.from(
    { length: 7 },
    (_, index) => `${String.fromCharCode(97 + index).repeat(16)}`,
  ).join(" ");
  raw.script.beats[1].onScreenText = "Seven long narration tokens";
  const draft = normalizeDraftBundle(raw);
  const timingContext = timingFor(draft, "renderer-line-budget");
  const storyIR = buildStoryIR({ draft, timingContext });
  const context = storyIR.beats.find((beat) => beat.role === "context");
  assert.equal(context.segments.length, 2);
  for (const segment of context.segments) {
    assert.ok(semanticSentenceTextLines(segment.text).length <= MAX_SEGMENT_LINES);
  }
  const compiled = compileProductionAnimation({
    animationProfile: "semantic-v3",
    projectId: "prj_generic_line_budget",
    projectRevision: 1,
    renderProfile: "preview",
    draft,
    timingContext,
  });
  assert.match(
    compileAnimationIRToHtml(compiled.animationIR, {
      semanticSourceContext: { draft, timingContext },
    }).compositionHash,
    /^[a-f0-9]{64}$/,
  );
});

test("StoryIR deduplicates repeated source operation kinds in source order", () => {
  const raw = readRaw("001_wow_signal_mystery");
  raw.storyboard.scenes[1].operations.push({
    ...structuredClone(raw.storyboard.scenes[1].operations[0]),
    text: "Independent archive copy",
    startFrame: 12,
  });
  const draft = normalizeDraftBundle(raw);
  const timingContext = timingFor(draft, "duplicate-operation-kind");
  const storyIR = buildStoryIR({ draft, timingContext });
  const context = storyIR.beats.find((beat) => beat.role === "context");
  assert.equal(
    context.source.operationKinds.filter((kind) => kind === "show_evidence").length,
    1,
  );
});

test("grounded cue semantics vary inside the same story vocabulary", () => {
  const original = build("001_wow_signal_mystery", "original-radio");
  const alteredRaw = readRaw("001_wow_signal_mystery");
  alteredRaw.claimLedger.claims.find((claim) => claim.id === "claim_frequency").text =
    "Researchers repeated the search, while the original radio record remained singular.";
  alteredRaw.script.beats[1].spokenText =
    "Researchers repeated the search again and again while the original radio record remained singular.";
  alteredRaw.script.beats[1].onScreenText = "The search repeated, the record did not";
  alteredRaw.storyboard.scenes[1].operations[0].text = "Repeated radio searches";
  const alteredDraft = normalizeDraftBundle(alteredRaw);
  const alteredTiming = timingFor(alteredDraft, "altered-radio");
  const alteredStoryIR = buildStoryIR({ draft: alteredDraft, timingContext: alteredTiming });
  const alteredGraph = buildVisualIntentGraph(alteredStoryIR, {
    draft: alteredDraft,
    timingContext: alteredTiming,
  });
  assert.equal(original.storyIR.storyVocabulary, "radio_signal");
  assert.equal(alteredStoryIR.storyVocabulary, "radio_signal");
  const originalContext = signature(original.visualIntentGraph).filter((_, index) => (
    original.visualIntentGraph.intents[index].role === "context"
  ));
  const alteredContext = signature(alteredGraph).filter((_, index) => (
    alteredGraph.intents[index].role === "context"
  ));
  assert.notDeepEqual(alteredContext, originalContext);
  assert.ok(alteredContext.some((value) => value.startsWith("recurrence:")));
});

test("StoryIR and visual intent contracts fail closed on gaps, bindings, order, continuity, and renderer gaps", () => {
  const { draft, timingContext, storyIR, visualIntentGraph } = build(
    "001_wow_signal_mystery",
    "adversarial",
  );
  const gap = structuredClone(storyIR);
  delete gap.contentHash;
  gap.beats[1].segments[0].startWordIndex += 1;
  assertFailure(
    () => normalizeStoryIR(gap),
    "ANIMATION_STORY_IR_INVALID",
    "segments_must_partition_beat",
  );

  const rebound = structuredClone(storyIR);
  delete rebound.contentHash;
  rebound.bindings.alignmentHash = "f".repeat(64);
  assertFailure(
    () => validateStoryIRAgainstDraft(rebound, { draft, timingContext }),
    "ANIMATION_STORY_IR_INVALID",
    "source_binding_mismatch",
  );

  const redistributedWords = structuredClone(storyIR);
  delete redistributedWords.contentHash;
  const multiSegmentBeat = redistributedWords.beats.find(
    (beat) => beat.segments.length === 2
      && beat.segments[0].endWordIndex - beat.segments[0].startWordIndex > 1,
  );
  const beatWords = multiSegmentBeat.wordSpan.text.split(/\s+/);
  multiSegmentBeat.segments[0].text = beatWords[0];
  multiSegmentBeat.segments[1].text = beatWords.slice(1).join(" ");
  assertFailure(
    () => normalizeStoryIR(redistributedWords),
    "ANIMATION_STORY_IR_INVALID",
    "segments_must_partition_beat",
  );

  const excessiveWrappedLines = structuredClone(storyIR);
  delete excessiveWrappedLines.contentHash;
  const hook = excessiveWrappedLines.beats[0];
  const longWord = "abcdefghijklmn";
  const sevenLineWords = Array.from({ length: 7 }, () => [longWord, "a"])
    .flat()
    .concat("a");
  assert.equal(sevenLineWords.length, hook.wordSpan.endWordIndex);
  hook.wordSpan.text = sevenLineWords.join(" ");
  hook.segments = [{
    ...structuredClone(hook.wordSpan),
    text: hook.wordSpan.text,
  }];
  assertFailure(
    () => normalizeStoryIR(excessiveWrappedLines),
    "ANIMATION_STORY_IR_INVALID",
    "segments_must_partition_beat",
  );

  const tamperedSegmentFrames = structuredClone(storyIR);
  delete tamperedSegmentFrames.contentHash;
  const segmentedBeat = tamperedSegmentFrames.beats.find(
    (beat) => beat.segments.length > 1,
  );
  segmentedBeat.segments[0].endFrame -= 1;
  assertFailure(
    () => buildVisualIntentGraph(tamperedSegmentFrames, { draft, timingContext }),
    "ANIMATION_STORY_IR_INVALID",
    "source_binding_mismatch",
  );

  const reorderedIntents = structuredClone(visualIntentGraph);
  delete reorderedIntents.contentHash;
  [
    reorderedIntents.intents[0],
    reorderedIntents.intents[1],
  ] = [
    reorderedIntents.intents[1],
    reorderedIntents.intents[0],
  ];
  assertFailure(
    () => normalizeVisualIntentGraph(reorderedIntents),
    "ANIMATION_VISUAL_INTENT_GRAPH_INVALID",
    "intent_order_or_identity_invalid",
  );

  const reboundContinuity = structuredClone(visualIntentGraph);
  delete reboundContinuity.contentHash;
  assert.ok(reboundContinuity.continuity[0].beatIds.length > 1);
  reboundContinuity.continuity[0].beatIds.reverse();
  assertFailure(
    () => normalizeVisualIntentGraph(reboundContinuity),
    "ANIMATION_VISUAL_INTENT_GRAPH_INVALID",
    "entity_beat_binding_mismatch",
  );

  const unsupportedRendererAsset = structuredClone(visualIntentGraph);
  delete unsupportedRendererAsset.contentHash;
  const targetIntent = unsupportedRendererAsset.intents.find(
    (intent) => intent.role === "context",
  );
  const targetEntity = unsupportedRendererAsset.entities.find(
    (entity) => entity.id === targetIntent.entityId,
  );
  targetEntity.subjectKind = "evidence";
  for (const intent of unsupportedRendererAsset.intents) {
    if (intent.entityId === targetEntity.id) intent.visualIntent = {
      predicate: "appearance",
      subjectKind: "evidence",
      stateTransition: "become_visible",
    };
  }
  assertFailure(
    () => normalizeVisualIntentGraph(unsupportedRendererAsset),
    "ANIMATION_VISUAL_INTENT_GRAPH_INVALID",
    "renderer_asset_unavailable",
  );
});

test("generalized sentence plans deterministically compose one primary and two grounded supporting modules", () => {
  const supportKinds = new Set();
  const layoutIds = new Set();
  const storyCompositionSignatures = [];
  const sourceBySupportKind = {
    detail_card: "cue_detail",
    quantity_badge: "display_quantity",
    route_trace: "approved_route",
  };

  for (const [id] of CASES) {
    const first = build(id);
    const repeated = build(id);
    assert.deepEqual(repeated.sentencePlan, first.sentencePlan, id);
    assert.equal(
      first.sentencePlan.sceneCompositionProfileId,
      SEMANTIC_SCENE_COMPOSITION_PROFILE_ID,
      id,
    );
    assertDeepFrozen(first.sentencePlan, `${id}.sentencePlan`);

    const compositions = first.sentencePlan.sentences.map(
      (sentence) => sentence.sceneComposition,
    );
    assert.ok(compositions.length >= 5, id);
    for (let index = 0; index < compositions.length; index += 1) {
      const sentence = first.sentencePlan.sentences[index];
      const composition = compositions[index];
      assert.ok(composition, `${id}:${sentence.id}`);
      assert.deepEqual(
        normalizeSemanticSceneComposition(composition),
        composition,
        `${id}:${sentence.id}`,
      );
      assert.equal(
        composition.schemaVersion,
        SEMANTIC_SCENE_COMPOSITION_SCHEMA_VERSION,
      );
      assert.equal(composition.profileId, SEMANTIC_SCENE_COMPOSITION_PROFILE_ID);
      assert.equal(composition.id, `composition_${sentence.propositionId}`);
      assert.ok(SEMANTIC_SCENE_COMPOSITION_LAYOUT_IDS.includes(
        composition.layoutId,
      ));
      assert.equal(composition.modules.length, 3);
      assert.equal(composition.links.length, 2);
      assert.deepEqual(composition.modules[0], {
        id: "module_primary",
        role: "primary",
        kind: "primary_geometry",
        source: "primary_geometry",
        slot: "primary",
        revealOrder: 0,
      });

      const supportKind = expectedCompositionSupportKind(
        sentence.primitiveParameters,
      );
      assert.deepEqual(composition.modules[1], {
        id: "module_support_a",
        role: "supporting",
        kind: supportKind,
        source: sourceBySupportKind[supportKind],
        slot: "support_a",
        revealOrder: 1,
      });
      assert.deepEqual(composition.modules[2], {
        id: "module_support_b",
        role: "supporting",
        kind: "state_badge",
        source: "semantic_state",
        slot: "support_b",
        revealOrder: 2,
      });
      assert.deepEqual(composition.links, [
        {
          fromModuleId: "module_primary",
          toModuleId: "module_support_a",
          relation: "context",
        },
        {
          fromModuleId: "module_primary",
          toModuleId: "module_support_b",
          relation: "state",
        },
      ]);
      assert.ok(composition.modules.every(
        (module) => SEMANTIC_SCENE_COMPOSITION_MODULE_KINDS.includes(module.kind),
      ));
      assertDeepFrozen(composition, `${id}.${sentence.id}.sceneComposition`);
      supportKinds.add(supportKind);
      layoutIds.add(composition.layoutId);
      if (index > 0) {
        assert.notEqual(
          composition.layoutId,
          compositions[index - 1].layoutId,
          `${id}: adjacent sentences must not reuse a layout`,
        );
      }
    }
    storyCompositionSignatures.push(compositions.map(
      (composition) => `${composition.layoutId}:${composition.variantSeed}`,
    ));
  }

  assert.deepEqual(
    [...supportKinds].sort(),
    ["detail_card", "quantity_badge", "route_trace"],
  );
  assert.ok(layoutIds.size >= 2);
  for (let left = 0; left < storyCompositionSignatures.length; left += 1) {
    for (let right = left + 1; right < storyCompositionSignatures.length; right += 1) {
      assert.notDeepEqual(
        storyCompositionSignatures[left],
        storyCompositionSignatures[right],
      );
    }
  }
});

test("generalized visual coherence rejects repetitive primary forms before rendering", async () => {
  const gps = build("002_gps_week_rollover", "semantic-coherence-gps");
  const report = buildSemanticVisualCoherenceReport(gps.sentencePlan);
  assert.equal(report.applicable, true);
  assert.equal(report.passed, true);
  assert.ok(report.metrics.distinctPrimaryFormCount >= 6);
  assert.ok(
    report.metrics.dominantPrimaryFormCount
      <= report.metrics.dominantPrimaryFormAllowance,
  );
  assert.equal(
    report.contentHash,
    buildSemanticVisualCoherenceReport(gps.sentencePlan).contentHash,
  );
  for (const fixtureId of [
    "001_wow_signal_mystery",
    "003_baychimo_icebound_drift",
    "004_general_word_collision",
  ]) {
    const fixtureReport = buildSemanticVisualCoherenceReport(
      build(fixtureId, `semantic-coherence-${fixtureId}`).sentencePlan,
    );
    const minimumDistinctPrimaryForms = fixtureId === "004_general_word_collision"
      ? 5
      : 6;
    assert.equal(fixtureReport.passed, true, fixtureId);
    assert.ok(
      fixtureReport.metrics.distinctPrimaryFormCount >= minimumDistinctPrimaryForms,
      fixtureId,
    );
    assert.ok(
      fixtureReport.metrics.dominantPrimaryFormCount <= 2,
      fixtureId,
    );
  }

  const neutralRaw = readRaw("002_gps_week_rollover");
  [
    "A blue shape rested near the edge beneath a soft overhead light.",
    "A small object stood beneath the pale surface at the quiet center.",
    "A narrow form occupied the middle beside several muted gray shapes.",
    "A dark outline remained near the wall under a steady amber glow.",
    "A quiet room contained one chair beneath a broad band of shadow.",
  ].forEach((spokenText, index) => {
    neutralRaw.script.beats[index].spokenText = spokenText;
  });
  const neutralCompilation = compileRaw(
    neutralRaw,
    "five-neutral-safe-forms",
    "prj_five_neutral_safe_forms",
  );
  const neutralPlan = neutralCompilation.compiled.animationIR.content
    .semanticVisualSentencePlan;
  assert.equal(neutralPlan.sentences.length, 5);
  assert.deepEqual(
    neutralPlan.sentences.map(
      (sentence) => sentence.primitiveParameters.visualConceptId,
    ),
    [
      "cue_evidence_focus",
      "cue_evidence_spotlight",
      "cue_evidence_field",
      "cue_evidence_ribbon",
      "cue_evidence_frame",
    ],
  );
  const neutralReport = buildSemanticVisualCoherenceReport(neutralPlan);
  assert.equal(neutralReport.passed, true);
  assert.equal(neutralReport.metrics.distinctPrimaryFormCount, 5);
  assert.equal(neutralReport.metrics.dominantPrimaryFormCount, 1);
  assert.equal(
    neutralCompilation.compiled.animationIR.content
      .semanticAnimationSceneDslPlan.scenes.length,
    5,
  );

  const nineNeutralRaw = readRaw("002_gps_week_rollover");
  [
    "A blue shape rested near the edge beneath soft light. A pale outline stood at the quiet center.",
    "A narrow form occupied the middle under a muted glow. A dark surface filled the lower part of the room.",
    "A small object stayed beside the wall under steady light. A broad shadow covered the empty space near it.",
    "A gray shape remained above the floor during a calm pause. A quiet background held the scene in place.",
    "A simple form rested in the center beneath a dim light.",
  ].forEach((spokenText, index) => {
    nineNeutralRaw.script.beats[index].spokenText = spokenText;
  });
  const nineNeutralCompilation = compileRaw(
    nineNeutralRaw,
    "nine-neutral-safe-forms",
    "prj_nine_neutral_safe_forms",
  );
  const nineNeutralPlan = nineNeutralCompilation.compiled.animationIR.content
    .semanticVisualSentencePlan;
  assert.equal(nineNeutralPlan.sentences.length, 9);
  assert.deepEqual(
    nineNeutralPlan.sentences.map(
      (sentence) => sentence.primitiveParameters.visualConceptId,
    ),
    [
      "cue_evidence_focus",
      "cue_evidence_spotlight",
      "cue_evidence_field",
      "cue_evidence_ribbon",
      "cue_evidence_frame",
      "cue_evidence_bands",
      "cue_evidence_focus",
      "cue_evidence_spotlight",
      "cue_evidence_field",
    ],
  );
  const nineNeutralReport = buildSemanticVisualCoherenceReport(
    nineNeutralPlan,
  );
  assert.equal(nineNeutralReport.passed, true);
  assert.equal(nineNeutralReport.metrics.distinctPrimaryFormCount, 6);
  assert.equal(nineNeutralReport.metrics.dominantPrimaryFormCount, 2);
  assert.equal(
    nineNeutralReport.metrics.dominantPrimaryFormAllowance,
    2,
  );
  assert.equal(
    nineNeutralCompilation.compiled.animationIR.content
      .semanticAnimationSceneDslPlan.scenes.length,
    9,
  );
  const neutralPrimitives = await import(
    "../renderer/hyperframes/primitives/semantic-sentence-primitives.mjs"
  );
  for (const [index, expectedVariant] of [
    "focus",
    "spotlight",
    "field",
    "ribbon",
    "frame",
    "bands",
  ].entries()) {
    assert.match(
      neutralPrimitives.semanticSentencePrimitiveMarkup(
        nineNeutralPlan.sentences[index],
        index,
      ),
      new RegExp(`data-evidence-variant="${expectedVariant}"`),
    );
  }

  const collapsed = structuredClone(gps.sentencePlan);
  const repeated = collapsed.sentences[0];
  collapsed.sentences.forEach((sentence) => {
    sentence.primitiveParameters.visualConceptId =
      repeated.primitiveParameters.visualConceptId;
    sentence.capability.assetId = repeated.capability.assetId;
    sentence.capability.grammarId = repeated.capability.grammarId;
    sentence.visualIntent.stateTransition =
      repeated.visualIntent.stateTransition;
    sentence.primitiveParameters.stateToken =
      repeated.primitiveParameters.stateToken;
    sentence.sceneComposition.geometryBlueprint.recipeId =
      repeated.sceneComposition.geometryBlueprint.recipeId;
  });
  const collapsedReport = buildSemanticVisualCoherenceReport(collapsed);
  assert.equal(collapsedReport.passed, false);
  assert.equal(collapsedReport.metrics.distinctPrimaryFormCount, 1);
  assert.ok(collapsedReport.violations.some(
    (violation) => (
      violation.code === "PRIMARY_FORM_DOMINANT_SHARE_EXCEEDED"
    ),
  ));
  assert.throws(
    () => assertSemanticVisualCoherence(collapsed),
    (error) => (
      error.code === "ANIMATION_SEMANTIC_VISUAL_COHERENCE_INVALID"
      && error.status === 409
    ),
  );

  const shortCollapsed = {
    ...structuredClone(collapsed),
    sentences: structuredClone(collapsed.sentences.slice(0, 4)),
  };
  const shortCollapsedReport = buildSemanticVisualCoherenceReport(
    shortCollapsed,
  );
  assert.equal(shortCollapsedReport.passed, false);
  assert.ok(shortCollapsedReport.violations.some(
    (violation) => violation.code === "PRIMARY_FORM_CONSECUTIVE_RUN_EXCEEDED",
  ));

  const distinctBases = [];
  for (const sentence of gps.sentencePlan.sentences) {
    if (distinctBases.some(
      (candidate) => primaryVisualFormSignature(candidate)
        === primaryVisualFormSignature(sentence),
    )) continue;
    distinctBases.push(sentence);
    if (distinctBases.length === 3) break;
  }
  assert.equal(distinctBases.length, 3);
  const dominantShortPlan = {
    ...structuredClone(gps.sentencePlan),
    sentences: [0, 1, 2, 0, 1, 0].map(
      (index) => structuredClone(distinctBases[index]),
    ),
  };
  const dominantShortReport = buildSemanticVisualCoherenceReport(
    dominantShortPlan,
  );
  assert.equal(dominantShortReport.passed, false);
  assert.equal(dominantShortReport.metrics.dominantPrimaryFormCount, 3);
  assert.ok(dominantShortReport.violations.some(
    (violation) => violation.code === "PRIMARY_FORM_DOMINANT_SHARE_EXCEEDED",
  ));
  const fourSentenceDominantPlan = {
    ...structuredClone(gps.sentencePlan),
    sentences: [0, 1, 0, 0].map(
      (index) => structuredClone(distinctBases[index]),
    ),
  };
  const fourSentenceDominantReport = buildSemanticVisualCoherenceReport(
    fourSentenceDominantPlan,
  );
  assert.equal(fourSentenceDominantReport.passed, false);
  assert.equal(
    fourSentenceDominantReport.metrics.dominantPrimaryFormCount,
    3,
  );
  assert.ok(fourSentenceDominantReport.violations.some(
    (violation) => violation.code === "PRIMARY_FORM_DOMINANT_SHARE_EXCEEDED",
  ));
  assert.equal(
    primaryVisualFormSignature(gps.sentencePlan.sentences[0]),
    "finite_counter_wrap|finite_counter|finite_cycle|finite_ring_v1",
  );

  const ordinaryMechanism = gps.sentencePlan.sentences.find(
    (sentence) => (
      sentence.wordSpan.text.includes("mechanism was ordinary")
    ),
  );
  assert.ok(ordinaryMechanism);
  assert.equal(
    ordinaryMechanism.primitiveParameters.visualConceptId,
    "cue_evidence_spotlight",
  );
  const genericConcepts = [
    "source_misinterpretation",
    "source_remediation",
    "mapping_cause_effect",
    "source_misinterpretation",
    "source_remediation",
    "mapping_cause_effect",
    "source_misinterpretation",
    "source_remediation",
  ];
  const disguisedGenericRepetition = {
    sceneCompositionProfileId: gps.sentencePlan.sceneCompositionProfileId,
    sentences: genericConcepts.map((visualConceptId, index) => {
      const sentence = structuredClone(ordinaryMechanism);
      sentence.id = `disguised_generic_${index}`;
      sentence.primitiveParameters.visualConceptId = visualConceptId;
      sentence.primitiveParameters.stateToken = "RESULT";
      return sentence;
    }),
  };
  assert.equal(
    new Set(disguisedGenericRepetition.sentences.map(
      primaryVisualFormSignature,
    )).size,
    1,
  );
  const disguisedReport = buildSemanticVisualCoherenceReport(
    disguisedGenericRepetition,
  );
  assert.equal(disguisedReport.passed, false);
  assert.equal(disguisedReport.metrics.distinctPrimaryFormCount, 1);
  assert.throws(
    () => assertSemanticVisualCoherence(disguisedGenericRepetition),
    (error) => error.code === "ANIMATION_SEMANTIC_VISUAL_COHERENCE_INVALID",
  );

  const legacyReport = buildSemanticVisualCoherenceReport({
    sentences: gps.sentencePlan.sentences,
  });
  assert.equal(legacyReport.applicable, false);
  assert.equal(legacyReport.passed, true);
});

test("generalized semantic-v3 carries source-bound primitive parameters into visible renderer markup", async () => {
  const { compileAnimationIRToHtml } = await import(
    "../renderer/hyperframes/animation-ir-adapter.mjs"
  );
  const {
    semanticSentenceRenderIntervals,
    semanticSimpleExplainerVisualGroups,
  } = await import(
    "../renderer/hyperframes/semantic-sentence-animation.mjs"
  );
  const { semanticSimpleExplainerHeading } = await import(
    "../renderer/hyperframes/primitives/semantic-sentence-primitives.mjs"
  );
  const {
    compileSemanticSimpleExplainerGroupActionSchedule,
    semanticSceneActionQaPlan,
  } = await import(
    "../renderer/hyperframes/semantic-scene-action-schedule.mjs"
  );
  const expectedSimpleGroups = {
    "001_wow_signal_mystery": {
      sentenceIndices: [[0], [1, 2], [3, 4], [5, 6], [7, 8]],
      anchors: [0, 1, 4, 6, 8],
      visualKinds: [
        "timeline",
        "state_change",
        "rejection",
        "uncertainty",
        "rejection",
      ],
    },
    "002_gps_week_rollover": {
      sentenceIndices: [
        [0], [1], [2, 3], [4, 5], [6], [7], [8], [9, 10], [11, 12],
      ],
      anchors: [0, 1, 2, 5, 6, 7, 8, 10, 12],
      visualKinds: [
        "cycle",
        "cause_effect",
        "bounded_structure",
        "cycle",
        "cause_effect",
        "timeline",
        "comparison",
        "state_change",
        "state_change",
      ],
    },
    "003_baychimo_icebound_drift": {
      sentenceIndices: [[0], [1, 2], [3], [4], [5, 6], [7, 8], [9]],
      anchors: [0, 2, 3, 4, 6, 8, 9],
      visualKinds: [
        "absence",
        "state_change",
        "evidence",
        "route",
        "timeline",
        "rejection",
        "uncertainty",
      ],
    },
  };
  for (const [id] of CASES) {
    const compiledValue = compileRaw(
      readRaw(id),
      `grounded-primitives-${id}`,
      `prj_grounded_${id}`,
    );
    const { compiled } = compiledValue;
    const graph = compiled.animationIR.content.semanticEventGraph;
    const plan = compiled.animationIR.content.semanticVisualSentencePlan;
    assert.equal(
      plan.sceneCompositionProfileId,
      SEMANTIC_SCENE_COMPOSITION_PROFILE_ID,
      id,
    );
    assert.equal(
      semanticVisualSentencePlanContentHash(plan),
      plan.contentHash,
      id,
    );
    assert.deepEqual(
      validateSemanticVisualSentencePlanAgainstGraph(plan, graph),
      plan,
      id,
    );
    for (const sentence of plan.sentences) {
      const parameters = sentence.primitiveParameters;
      assert.ok(parameters, `${id}:${sentence.id}`);
      assert.equal(parameters.profileId, SEMANTIC_PRIMITIVE_PARAMETER_PROFILE_ID);
      assert.equal(parameters.grammarId, sentence.capability.grammarId);
      assert.equal(parameters.assetId, sentence.capability.assetId);
      assert.equal(
        parameters.geometry.presetId,
        SEMANTIC_PRIMITIVE_PRESET_BY_GRAMMAR[sentence.capability.grammarId],
      );
      assert.equal(parameters.subject.value, parameters.subject.sourceRef.value);
      assert.equal(parameters.detail.value, parameters.detail.sourceRef.value);
      if (parameters.quantity) {
        assert.equal(
          parameters.quantity.value,
          parameters.quantity.valueSourceRef.value,
        );
        assert.equal(
          parameters.quantity.unit,
          parameters.quantity.unitSourceRef?.value || null,
        );
      }
      assert.deepEqual(
        normalizeSemanticPrimitiveParameters(parameters),
        parameters,
      );
      assertDeepFrozen(parameters, `${id}.${sentence.id}.primitiveParameters`);
      assert.ok(sentence.sceneComposition, `${id}:${sentence.id}`);
      assert.equal(
        sentence.sceneComposition.modules[1].kind,
        expectedCompositionSupportKind(parameters),
      );
      assertDeepFrozen(
        sentence.sceneComposition,
        `${id}.${sentence.id}.sceneComposition`,
      );
    }
    const composition = compileAnimationIRToHtml(
      compiled.animationIR,
      rendererSourceOptions(compiledValue),
    );
    const visualGroups = buildSemanticSimpleExplainerGroups(plan.sentences);
    const timedVisualGroups = semanticSimpleExplainerVisualGroups(
      plan.sentences,
      semanticSentenceRenderIntervals(
        plan.sentences,
        compiled.animationIR.durationFrames,
      ),
      compiled.animationIR.durationFrames,
    );
    const groupActionSchedule =
      compileSemanticSimpleExplainerGroupActionSchedule({
        sceneDslPlan:
          compiled.animationIR.content.semanticAnimationSceneDslPlan,
        sentences: plan.sentences,
        visualGroups: timedVisualGroups,
        fps: compiled.animationIR.fps,
        durationFrames: compiled.animationIR.durationFrames,
      });
    assert.ok(visualGroups.length >= 5 && visualGroups.length <= 10, id);
    assert.deepEqual(
      timedVisualGroups.map((group) => group.id),
      visualGroups.map((group) => group.id),
      id,
    );
    assert.equal(timedVisualGroups[0].startFrame, 0, id);
    assert.equal(
      timedVisualGroups.at(-1).endFrame,
      compiled.animationIR.durationFrames,
      id,
    );
    assert.equal(groupActionSchedule.scenes.length, visualGroups.length, id);
    assert.equal(
      semanticSceneActionQaPlan(groupActionSchedule).settledHoldFrames.length,
      visualGroups.length,
      id,
    );
    for (const [index, group] of timedVisualGroups.entries()) {
      assert.equal(
        group.startFrame,
        plan.sentences[group.firstSentenceIndex].wordSpan.startFrame,
        `${id}:${group.id}:start`,
      );
      assert.equal(
        group.semanticEndFrame,
        plan.sentences[group.lastSentenceIndex].wordSpan.endFrame,
        `${id}:${group.id}:semantic-end`,
      );
      assert.ok(
        group.endFrame >= group.semanticEndFrame,
        `${id}:${group.id}:tail-padding`,
      );
      assert.deepEqual(
        group.stepStartFrames,
        group.sentenceIndices.map(
          (sentenceIndex) => plan.sentences[sentenceIndex].wordSpan.startFrame,
        ),
        `${id}:${group.id}:narration-step-boundaries`,
      );
      if (index > 0) {
        assert.equal(
          timedVisualGroups[index - 1].endFrame,
          group.startFrame,
          `${id}:${group.id}:contiguous`,
        );
      }
      const actionScene = groupActionSchedule.scenes[index];
      assert.equal(actionScene.visualSceneId, group.id, `${id}:${group.id}`);
      assert.equal(
        actionScene.anchorSentenceIndex,
        group.anchorSentenceIndex,
        `${id}:${group.id}:action-anchor`,
      );
      assert.equal(
        actionScene.anchorSentenceId,
        group.anchorSentenceId,
        `${id}:${group.id}:action-anchor-id`,
      );
      assert.deepEqual(
        actionScene.sentenceIndices,
        group.sentenceIndices,
        `${id}:${group.id}:action-sentences`,
      );
      assert.equal(actionScene.startFrame, group.startFrame);
      assert.equal(actionScene.semanticEndFrame, group.semanticEndFrame);
      assert.equal(actionScene.endFrame, group.endFrame);
      assert.equal(
        actionScene.sceneDslId,
        compiled.animationIR.content.semanticAnimationSceneDslPlan
          .scenes[group.anchorSentenceIndex].sceneDsl.id,
      );
      assert.ok(actionScene.actions.every((action) => (
        action.target === "module_primary"
        && ["create", "move"].includes(action.op)
        && (action.op !== "move" || group.visualKind === "route")
      )));
      assert.equal(
        actionScene.actions.length,
        1,
        `${id}:${group.id}:single-motion-channel`,
      );
    }
    const segments = motionSegments(compiled.animationIR);
    assert.equal(segments.length, visualGroups.length, id);
    assert.deepEqual(
      segments.map((segment) => segment.id),
      visualGroups.map((group) => group.id),
      id,
    );
    assert.equal(segments[0].startFrame, 0, id);
    assert.equal(segments.at(-1).endFrame, compiled.animationIR.durationFrames, id);
    for (const [index, segment] of segments.entries()) {
      const group = visualGroups[index];
      assert.equal(
        segment.startFrame,
        plan.sentences[group.firstSentenceIndex].wordSpan.startFrame,
        `${id}:${segment.id}`,
      );
      if (index > 0) {
        assert.equal(
          segments[index - 1].endFrame,
          segment.startFrame,
          `${id}:${segment.id}`,
        );
      }
    }
    assert.equal(composition.profile.presentationProfileId,
      SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID);
    assert.equal(composition.profile.visualSceneCount, visualGroups.length);
    assert.match(
      composition.html,
      /visual\.endFrame-visual\.startFrame-1/,
      `${id}: visual motion must settle through the complete scene interval`,
    );
    assert.doesNotMatch(
      composition.html,
      /visual\.semanticEndFrame-visual\.startFrame-1\)\);\n const semanticProgress/,
      `${id}: semantic tail padding cannot become a frozen visual gap`,
    );
    assert.ok(visualGroups.every((group) => group.sentenceIndices.length >= 1));
    assert.deepEqual(
      visualGroups.flatMap((group) => group.sentenceIndices),
      plan.sentences.map((_sentence, index) => index),
      id,
    );
    assert.ok(
      visualGroups.every((group) => (
        group.sentenceIndices.length >= 1
        && group.sentenceIndices.length <= 2
      )),
      id,
    );
    const visualKinds = visualGroups.map((group) => group.visualKind);
    const selectedForms = visualGroups.map((group) => (
      primaryVisualFormSignature(plan.sentences[group.anchorSentenceIndex])
    ));
    assert.ok(selectedForms.every(Boolean), id);
    const expectedGrouping = expectedSimpleGroups[id];
    if (expectedGrouping) {
      assert.ok(
        timedVisualGroups.every((group) => (
          group.endFrame - group.startFrame >= 54
        )),
        `${id}: every corpus visual must remain readable for at least 1.8 seconds`,
      );
      assert.deepEqual(
        visualGroups.map((group) => group.sentenceIndices),
        expectedGrouping.sentenceIndices,
        `${id}: sentence groups`,
      );
      assert.deepEqual(
        visualGroups.map((group) => group.anchorSentenceIndex),
        expectedGrouping.anchors,
        `${id}: visual drivers`,
      );
      assert.deepEqual(
        visualKinds,
        expectedGrouping.visualKinds,
        `${id}: visual kinds`,
      );
      const visualKindCounts = new Map();
      for (const kind of visualKinds) {
        visualKindCounts.set(kind, (visualKindCounts.get(kind) || 0) + 1);
      }
      assert.ok(Math.max(...visualKindCounts.values()) <= 2, id);
      assert.ok(
        new Set(visualKinds).size >= Math.ceil(visualGroups.length * 0.5),
        `${id}: simple visual-kind floor`,
      );
    }
    assert.match(composition.html, /data-primitive-parameterized="true"/);
    assert.equal(
      [...composition.html.matchAll(/class="semantic-scene-composition"/g)].length,
      visualGroups.length,
      id,
    );
    assert.equal(
      [...composition.html.matchAll(/data-scene-module-id="module_primary"/g)].length,
      visualGroups.length,
      id,
    );
    assert.equal(
      [...composition.html.matchAll(/data-scene-module-id="module_support_a"/g)].length,
      visualGroups.length,
      id,
    );
    assert.equal(
      [...composition.html.matchAll(/data-scene-module-id="module_support_b"/g)].length,
      visualGroups.length,
      id,
    );
    assert.equal(
      [...composition.html.matchAll(
        /<g[^>]+class="[^"]*semantic-support-module[^"]*"[^>]*>/g,
      )].length,
      visualGroups.length * 2,
      id,
    );
    assert.doesNotMatch(
      composition.html,
      /\.semantic-support-module\{[^}]*opacity\s*:/,
      `${id}: CSS cannot override runtime support visibility`,
    );
    assert.doesNotMatch(
      composition.html,
      /\.semantic-composition-link\{[^}]*opacity\s*:/,
      `${id}: CSS cannot override runtime link visibility`,
    );
    assert.equal(
      [...composition.html.matchAll(
        /class="semantic-support-module[^"]*" opacity="0"/g,
      )].length,
      visualGroups.length * 2,
      id,
    );
    assert.equal(
      [...composition.html.matchAll(/class="sentence-concept-label"/g)].length,
      visualGroups.reduce(
        (count, group) => count + group.sentenceIndices.length,
        0,
      ),
      id,
    );
    assert.equal(
      [...composition.html.matchAll(
        /data-simple-explainer-primary="true"/g,
      )].length,
      visualGroups.length,
      `${id}: every visual group requires one simple primary`,
    );
    assert.equal(
      [...composition.html.matchAll(/data-simple-focus-root="true"/g)].length,
      visualGroups.length,
      `${id}: every visual group requires one focal root`,
    );
    assert.equal(
      [...composition.html.matchAll(/semantic-simple-object/g)].length,
      visualGroups.length,
      `${id}: every scene must render exactly one visible object cluster`,
    );
    assert.equal(
      [...composition.html.matchAll(
        /data-visual-role="nonvisual_scene_topology">\s*<g class="semantic-bounded-geometry"/g,
      )].length,
      visualGroups.length,
      `${id}: provenance geometry must remain inside hidden topology`,
    );
    const simpleStepCounts = [...composition.html.matchAll(
      /data-simple-visible-step-count="(\d+)"/g,
    )].map((match) => Number(match[1]));
    const simpleFocalCounts = [...composition.html.matchAll(
      /data-simple-focal-object-count="(\d+)"/g,
    )].map((match) => Number(match[1]));
    const simpleLabelCounts = [...composition.html.matchAll(
      /data-simple-label-count="(\d+)"/g,
    )].map((match) => Number(match[1]));
    assert.equal(simpleStepCounts.length, visualGroups.length, id);
    assert.equal(simpleFocalCounts.length, visualGroups.length, id);
    assert.equal(simpleLabelCounts.length, visualGroups.length, id);
    assert.ok(simpleStepCounts.every((count) => count >= 1 && count <= 2), id);
    assert.ok(simpleFocalCounts.every((count) => count === 1), id);
    assert.ok(simpleLabelCounts.every((count) => count <= 2), id);
    assert.equal(
      [...composition.html.matchAll(
        /class="[^"]*semantic-step-secondary[^"]*"/g,
      )].length,
      simpleStepCounts.filter((count) => count === 2).length,
      `${id}: every declared second step requires one timed visual change`,
    );
    assert.match(
      composition.html,
      /cameraChannel\.style\.transform="none"/,
      `${id}: simple scenes cannot add camera motion`,
    );
    assert.doesNotMatch(
      composition.html,
      /beatDrift|will-change:/,
      `${id}: simple scenes cannot stack ambient compositor motion`,
    );
    assert.match(
      composition.html,
      /const revealEase=\(value\)=>clamp\(value\)/,
      `${id}: the focal object must become readable immediately`,
    );
    assert.match(
      composition.html,
      /const revealProgress=revealEase\(\(frame-visual\.startFrame\)\/visual\.presentationTiming\.revealDurationFrames\)/,
      `${id}: simple scenes must use the dedicated focal reveal curve`,
    );
    assert.match(
      composition.html,
      /const presentedOpacity=moduleState\.id==="module_primary"\s*\?revealProgress\s*:moduleState\.opacity/,
      `${id}: the create action and focal reveal must share one opacity channel`,
    );
    assert.match(
      composition.html,
      /const translateX=\(simpleCreateAction\?0:moduleState\.translateX\)\+routeShift\.x/,
      `${id}: create cannot add a second translation channel`,
    );
    assert.match(
      composition.html,
      /const presentedScale=simpleCreateAction\?1:moduleState\.scale/,
      `${id}: create cannot add a second scale channel`,
    );
    assert.match(
      composition.html,
      /setOpacity\(header,0\)/,
      `${id}: the simple presenter must not compete with a global title`,
    );
    assert.doesNotMatch(
      composition.html,
      /10\*\(1-secondaryProgress\)|-8\*secondaryProgress/,
      `${id}: narration-step changes must use opacity only`,
    );
    assert.match(
      composition.html,
      /const routeActionProgress=sceneActionState\.routeProgress===null\s*\?1\s*:sceneActionState\.routeProgress/,
      `${id}: an ungrounded route marker must stay static after reveal`,
    );
    assert.match(
      composition.html,
      /semanticSceneActionStateAtFrame\(visual\.sceneActionSchedule,frame\)/,
      `${id}: composed visuals must use their group-level action schedule`,
    );
    assert.doesNotMatch(
      composition.html,
      /semanticSceneActionStateAtFrame\(active\.sceneActionSchedule,frame\)/,
      `${id}: sentence actions cannot replace a visible group's actions`,
    );
    assert.match(
      composition.html,
      /const initialStageAttributeState=stages\.map/,
      `${id}: composed stages require history-independent resets`,
    );
    assert.match(
      composition.html,
      /restoreInitialStageState\(lastRenderedStageIndex\)/,
      `${id}: inactive stage state must not survive a random seek`,
    );
    assert.match(
      composition.html,
      /restoreInitialStageState\(visualIndex\)/,
      `${id}: every frame must begin from canonical stage attributes`,
    );
    assert.match(
      composition.html,
      /element\.style\.visibility=visible\?"visible":"hidden"/,
      `${id}: inactive stages must not participate in Chromium paint`,
    );
    assert.equal(
      composition.actionQa.scheduleHash,
      groupActionSchedule.contentHash,
      `${id}: renderer action QA must cover visual groups`,
    );
    assert.equal(
      composition.actionQa.settledHoldFrames.length,
      visualGroups.length,
      `${id}: one settled action hold per visual group`,
    );
    for (const group of timedVisualGroups) {
      const timing = group.presentationTiming;
      assert.ok(timing.revealSettleFrame <= (
        timing.secondaryRevealStartFrame ?? group.semanticEndFrame
      ));
      if (timing.secondaryRevealStartFrame !== null) {
        assert.ok(timing.secondaryRevealSettleFrame < group.semanticEndFrame);
        for (const frame of [
          timing.secondaryRevealStartFrame,
          Math.floor((
            timing.secondaryRevealStartFrame
            + timing.secondaryRevealSettleFrame
          ) / 2),
          timing.secondaryRevealSettleFrame,
        ]) {
          assert.ok(
            composition.actionQa.phaseFrames.includes(frame),
            `${id}:${group.id}: secondary reveal checkpoint ${frame}`,
          );
        }
      }
    }
    for (const [index, scene] of groupActionSchedule.scenes.entries()) {
      const action = scene.actions[0];
      if (action.op === "move") {
        assert.ok(
          action.startFrame >= timedVisualGroups[index]
            .presentationTiming.revealSettleFrame,
          `${id}:${scene.visualSceneId}: route starts after reveal`,
        );
      }
    }
    const expectedHeadingEntries = visualGroups.flatMap((group) => {
      const groupText = group.sentenceIndices.map(
        (index) => plan.sentences[index].wordSpan.text,
      ).join(" ");
      return group.sentenceIndices.map((sentenceIndex) => {
        const sentence = plan.sentences[sentenceIndex];
        return {
          heading: semanticSimpleExplainerHeading(
            sentence.primitiveParameters,
            groupText,
            120,
          ),
          source: sentence.wordSpan.text,
          parameters: sentence.primitiveParameters,
          groupText,
        };
      });
    });
    const expectedConceptHeadings = expectedHeadingEntries.map(
      (entry) => entry.heading,
    );
    const renderedConceptHeadings = [...composition.html.matchAll(
      /id="semantic-concept-\d+(?:-secondary)?"[^>]*>([\s\S]*?)<\/text>/g,
    )].map((match) => {
      const lines = [...match[1].matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)]
        .map((line) => line[1]);
      return lines.length ? lines.join(" ") : match[1];
    });
    assert.deepEqual(renderedConceptHeadings, expectedConceptHeadings, id);
    const renderedConceptTags = [...composition.html.matchAll(
      /<text id="semantic-concept-\d+(?:-secondary)?"([^>]*)>/g,
    )].map((match) => match[1]);
    assert.equal(renderedConceptTags.length, expectedHeadingEntries.length, id);
    for (const [index, attributes] of renderedConceptTags.entries()) {
      assert.doesNotMatch(
        attributes,
        /(?:textLength|lengthAdjust)=/,
        `${id}:heading:${index}:glyph-compression`,
      );
      const inlineFontSize = attributes.match(/font-size:(\d+)px/);
      if (inlineFontSize) {
        assert.ok(
          Number(inlineFontSize[1]) >= 24,
          `${id}:heading:${index}:mobile-font-floor`,
        );
      }
    }
    const visibleMicroCopyCount = [
      ...composition.html.matchAll(/class="[^"]*\bmicro-copy\b[^"]*"/g),
    ].length;
    const markedMicroCopyCount = [
      ...composition.html.matchAll(
        /id="semantic-simple-label-\d+-\d+"[^>]*data-legibility-role="secondary"/g,
      ),
    ].length;
    assert.equal(
      markedMicroCopyCount,
      visibleMicroCopyCount,
      `${id}: every explanatory micro-label must enter mobile legibility QA`,
    );
    assert.ok(
      expectedConceptHeadings.every((heading, index) => (
        index === 0 || heading !== expectedConceptHeadings[index - 1]
      )),
      `${id}: adjacent simple scenes require distinct headings`,
    );
    for (const [index, entry] of expectedHeadingEntries.entries()) {
      const { heading } = entry;
      assert.equal(heading.length <= 120, true, `${id}:heading:${index}`);
      assertHeadingIsSourceSubsequence(
        entry.source,
        heading,
        `${id}:heading:${index}:source-binding`,
      );
      assert.equal(
        semanticSimpleExplainerHeading(
          entry.parameters,
          entry.groupText,
          120,
        ),
        heading,
        `${id}:heading:${index}:deterministic`,
      );
    }
    if (id === "002_gps_week_rollover") {
      assert.deepEqual(
        visualGroups.map((group) => group.sentenceIndices),
        [[0], [1], [2, 3], [4, 5], [6], [7], [8], [9, 10], [11, 12]],
      );
      assert.deepEqual(
        visualGroups.map((group) => group.anchorSentenceIndex),
        [0, 1, 2, 5, 6, 7, 8, 10, 12],
      );
      assert.deepEqual(
        visualGroups.map((group) => (
          plan.sentences[group.anchorSentenceIndex]
            .primitiveParameters.visualConceptId
        )),
        [
          "finite_counter_wrap",
          "counter_date_misinterpretation",
          "encoded_bit_register",
          "counter_recurrence",
          "receiver_patch_required",
          "future_rollover_timeline",
          "counter_capacity_comparison",
          "cue_evidence_spotlight",
          "hypothesis_rejection",
        ],
      );
      const selectedPrimaryForms = visualGroups.map((group) => (
        primaryVisualFormSignature(plan.sentences[group.anchorSentenceIndex])
      ));
      assert.equal(selectedPrimaryForms.every(Boolean), true);
      assert.equal(
        new Set(selectedPrimaryForms).size,
        selectedPrimaryForms.length,
        "GPS simple scenes must not repeat a selected primary animation form",
      );
      assert.equal(
        timedVisualGroups.some((group) => (
          group.endFrame > group.semanticEndFrame
        )),
        true,
        "GPS visual groups must preserve real narration tail padding",
      );
      assert.deepEqual(
        simpleStepCounts,
        [1, 1, 2, 2, 1, 1, 1, 2, 2],
      );
      assert.deepEqual(
        simpleFocalCounts,
        Array.from({ length: 9 }, () => 1),
      );
      assert.ok(simpleLabelCounts.every((count) => count <= 2));
      assert.match(
        composition.html,
        /data-comparison-concept="counter_vs_time"/,
      );
      assert.match(
        composition.html,
        /data-simple-renderer-variant="software_patch_card"/,
      );
      assert.match(
        composition.html,
        /data-simple-renderer-variant="mystery_to_counter_loop"/,
      );
      assert.match(
        composition.html,
        /data-simple-mechanism="finite_counter_loop"/,
      );
      assert.match(composition.html, />FINITE COUNTER LOOP</);
      assert.doesNotMatch(composition.html, />INTERPRET<|>UPDATE REQUIRED</);
    }
    assert.doesNotMatch(composition.html, /class="semantic-sentence-copy"/);
    assert.doesNotMatch(composition.html,
      /semantic-support-(?:surface|label|value|quantity|state|route)/);
    assert.match(composition.html,
      new RegExp(`data-semantic-presentation-profile-id="${SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID}"`));
    for (const group of visualGroups) {
      const sentence = plan.sentences[group.anchorSentenceIndex];
      const { sceneComposition } = sentence;
      assert.ok(composition.html.includes(
        `data-scene-composition-id="${sceneComposition.id}"`,
      ));
      assert.ok(composition.html.includes(
        `data-scene-composition-layout-id="${sceneComposition.layoutId}"`,
      ));
      assert.ok(composition.html.includes(
        `data-scene-composition-profile-id="${sceneComposition.profileId}"`,
      ));
    }
    assert.doesNotMatch(composition.html, />1023<|>0000<|>DATE<|>INPUT<|>OUTPUT</);
  }
});

test("bounded geometry factory compiles distinct source-bound programs into visible safe markup", async () => {
  const boundedRenderer = await import(
    "../renderer/hyperframes/primitives/semantic-bounded-geometry.mjs"
  );
  const blueprintHashes = new Set();
  const programHashes = new Set();
  const visibleGeometrySignatures = new Set();
  const recipeIds = new Set();
  let sentenceCount = 0;
  let approvedRouteCount = 0;

  for (const [id] of CASES) {
    const value = compileRaw(
      id === "003_baychimo_icebound_drift"
        ? readBaychimoWithGroundedRoute()
        : readRaw(id),
      `bounded-geometry-${id}`,
      `prj_bounded_geometry_${id}`,
    );
    const graph = value.compiled.animationIR.content.semanticEventGraph;
    const plan = value.compiled.animationIR.content.semanticVisualSentencePlan;
    for (const sentence of plan.sentences) {
      sentenceCount += 1;
      const blueprint = sentence.sceneComposition.geometryBlueprint;
      const context = {
        semanticEventGraphHash: graph.contentHash,
        propositionId: sentence.propositionId,
        primitiveParameters: sentence.primitiveParameters,
      };
      assert.equal(
        blueprint.schemaVersion,
        SEMANTIC_GEOMETRY_BLUEPRINT_SCHEMA_VERSION,
      );
      assert.equal(blueprint.profileId, SEMANTIC_GEOMETRY_BLUEPRINT_PROFILE_ID);
      assert.equal(
        blueprint.recipeId,
        sentence.primitiveParameters.geometry.route
          ? "route_field_v1"
          : SEMANTIC_GEOMETRY_RECIPE_BY_GRAMMAR[
            sentence.primitiveParameters.grammarId
          ],
      );
      if (sentence.primitiveParameters.geometry.route) {
        const count = sentence.primitiveParameters.geometry.route.points.length;
        assert.equal(
          blueprint.controls.density,
          count <= 4 ? "sparse" : count >= 8 ? "dense" : "balanced",
        );
      } else {
        const [minimumNodes, maximumNodes] =
          SEMANTIC_GEOMETRY_NODE_RANGE_BY_RECIPE[blueprint.recipeId];
        assert.equal(
          blueprint.controls.nodeCount,
          blueprint.controls.density === "sparse"
            ? minimumNodes
            : blueprint.controls.density === "dense"
              ? maximumNodes
              : Math.round((minimumNodes + maximumNodes) / 2),
      );
    }
      assert.equal(
        blueprint.bindings.semanticEventGraphHash,
        graph.contentHash,
      );
      assert.equal(blueprint.bindings.propositionId, sentence.propositionId);
      assert.equal(
        blueprint.bindings.primitiveParametersHash,
        primitiveParametersHash(sentence.primitiveParameters),
      );
      assert.deepEqual(
        validateSemanticGeometryBlueprintAgainstContext(blueprint, context),
        blueprint,
      );
      assert.deepEqual(buildSemanticGeometryBlueprint(context), blueprint);

      const program = compileSemanticGeometryProgram({
        geometryBlueprint: blueprint,
        primitiveParameters: sentence.primitiveParameters,
        propositionId: sentence.propositionId,
        semanticEventGraphHash: graph.contentHash,
      });
      assert.equal(program.profileId, SEMANTIC_GEOMETRY_PROGRAM_PROFILE_ID);
      assert.equal(program.blueprintHash, blueprint.contentHash);
      assert.equal(program.nodes.length, blueprint.controls.nodeCount);
      assert.equal(
        program.complexityCost,
        program.nodes.length + program.edges.length,
      );
      assert.deepEqual(
        compileSemanticGeometryProgram({
          geometryBlueprint: structuredClone(blueprint),
          primitiveParameters: structuredClone(sentence.primitiveParameters),
          propositionId: sentence.propositionId,
          semanticEventGraphHash: graph.contentHash,
        }),
        program,
      );
      assertDeepFrozen(blueprint, `${id}.${sentence.id}.geometryBlueprint`);
      assertDeepFrozen(program, `${id}.${sentence.id}.geometryProgram`);

      if (sentence.primitiveParameters.geometry.route) {
        approvedRouteCount += 1;
        const expectedPoints = sentence.primitiveParameters.geometry.route.points
          .map(([x, y]) => [Math.round(x * 1000), Math.round(y * 1000)]);
        assert.equal(program.provenance, "approved_storyboard_layout");
        assert.deepEqual(
          program.nodes.map((node) => [node.x, node.y]),
          expectedPoints,
        );
        assert.deepEqual(
          program.edges.map((edge) => edge.kind),
          expectedPoints.slice(1).map((point, index) => (
            point[0] === expectedPoints[index][0]
              && point[1] === expectedPoints[index][1]
              ? "dwell"
              : "line"
          )),
        );
      } else {
        assert.equal(program.provenance, "deterministic_illustrative");
      }

      const markup = boundedRenderer.semanticBoundedGeometryMarkup(sentence);
      assert.match(markup, /class="semantic-bounded-geometry"/);
      assert.ok(markup.includes(
        `data-bounded-geometry-blueprint-hash="${blueprint.contentHash}"`,
      ));
      assert.ok(markup.includes(
        `data-bounded-geometry-program-hash="${program.contentHash}"`,
      ));
      assert.equal(
        [...markup.matchAll(/class="semantic-bounded-node"/g)].length,
        program.nodes.length,
      );
      assert.equal(
        [...markup.matchAll(/class="semantic-draw semantic-bounded-edge/g)].length,
        program.edges.length,
      );
      assert.equal(
        [...markup.matchAll(/pathLength="1000"/g)].length,
        program.edges.length,
      );
      assert.doesNotMatch(
        markup,
        /<(?:script|foreignObject)|javascript:|\b(?:href|onload|onclick|style)=/i,
      );
      assert.doesNotMatch(markup, /NaN|Infinity|undefined/);

      blueprintHashes.add(blueprint.contentHash);
      programHashes.add(program.contentHash);
      visibleGeometrySignatures.add(JSON.stringify({
        nodes: program.nodes,
        edges: program.edges,
      }));
      recipeIds.add(blueprint.recipeId);
    }
  }

  assert.equal(blueprintHashes.size, sentenceCount);
  assert.equal(programHashes.size, sentenceCount);
  assert.equal(visibleGeometrySignatures.size, sentenceCount);
  assert.ok(recipeIds.size >= 6);
  assert.ok(approvedRouteCount >= 1);
});

test("unresolved state keeps reject geometry while support topology stays nonvisual", async () => {
  const sceneRenderer = await import(
    "../renderer/hyperframes/primitives/semantic-scene-composition.mjs"
  );
  const value = compileRaw(
    readRaw("001_wow_signal_mystery"),
    "bounded-geometry-unresolved-tone",
    "prj_bounded_geometry_unresolved_tone",
  );
  const graph = value.compiled.animationIR.content.semanticEventGraph;
  const sentence = value.compiled.animationIR.content
    .semanticVisualSentencePlan.sentences[0];
  const primitiveParameters = structuredClone(sentence.primitiveParameters);
  primitiveParameters.stateToken = "UNRESOLVED";
  const sceneComposition = buildSemanticSceneComposition({
    graphHash: graph.contentHash,
    propositionId: sentence.propositionId,
    primitiveParameters,
    capability: sentence.capability,
    recentLayoutIds: [],
  });
  const program = compileSemanticGeometryProgram({
    geometryBlueprint: sceneComposition.geometryBlueprint,
    primitiveParameters,
    propositionId: sentence.propositionId,
    semanticEventGraphHash: graph.contentHash,
  });
  assert.equal(
    program.nodes[sceneComposition.geometryBlueprint.controls.emphasisIndex]
      .tone,
    "reject",
  );

  let unrelatedGetterExecuted = false;
  const rendererSentence = {
    ...sentence,
    primitiveParameters,
    sceneComposition,
  };
  Object.defineProperty(rendererSentence, "unrelatedProbe", {
    enumerable: true,
    get() {
      unrelatedGetterExecuted = true;
      throw new Error("unrelated sentence getter must not execute");
    },
  });
  const markup = sceneRenderer.semanticSceneCompositionMarkup(
    rendererSentence,
    '<g class="test-primary"/>',
    0,
  );
  assert.equal(unrelatedGetterExecuted, false);
  assert.match(markup, /data-blueprint-node-tone="reject"/);
  assert.match(markup, /class="semantic-support-module semantic-support-stub"/);
  assert.match(markup, /class="semantic-nonvisual-topology" opacity="0"/);
  assert.doesNotMatch(markup, />UNRESOLVED<\/text>|semantic-support-surface/);
});

test("bounded geometry contracts reject injection, malformed data, and fresh-hash rebinding", () => {
  const value = compileRaw(
    readRaw("001_wow_signal_mystery"),
    "bounded-geometry-adversarial",
    "prj_bounded_geometry_adversarial",
  );
  const graph = value.compiled.animationIR.content.semanticEventGraph;
  const plan = value.compiled.animationIR.content.semanticVisualSentencePlan;
  const sentence = plan.sentences[0];
  const otherSentence = plan.sentences[1];
  const blueprint = sentence.sceneComposition.geometryBlueprint;
  const context = {
    semanticEventGraphHash: graph.contentHash,
    propositionId: sentence.propositionId,
    primitiveParameters: sentence.primitiveParameters,
  };
  const program = compileSemanticGeometryProgram({
    geometryBlueprint: blueprint,
    primitiveParameters: sentence.primitiveParameters,
    propositionId: sentence.propositionId,
    semanticEventGraphHash: graph.contentHash,
  });

  for (const field of ["svg", "path", "javascript", "style", "href", "onload"]) {
    const injected = structuredClone(blueprint);
    injected[field] = field === "svg" ? "<svg onload='unsafe()'/>" : "unsafe";
    assertFailure(
      () => normalizeSemanticGeometryBlueprint(injected),
      "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
      "unsupported_field",
    );
  }

  const controlInjection = structuredClone(blueprint);
  controlInjection.controls.coordinates = [0, 0];
  assertFailure(
    () => normalizeSemanticGeometryBlueprint(controlInjection),
    "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
    "unsupported_field",
  );

  let getterExecuted = false;
  const accessor = structuredClone(blueprint);
  Object.defineProperty(accessor, "recipeId", {
    enumerable: true,
    get() {
      getterExecuted = true;
      return blueprint.recipeId;
    },
  });
  assertFailure(
    () => normalizeSemanticGeometryBlueprint(accessor),
    "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
    "plain_data_field_required",
  );
  assert.equal(getterExecuted, false);

  const symbolField = structuredClone(blueprint);
  symbolField[Symbol("svg")] = "<svg/>";
  assertFailure(
    () => normalizeSemanticGeometryBlueprint(symbolField),
    "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
    "unsupported_field",
  );

  const pollutedPrototype = Object.assign(
    Object.create({ injected: true }),
    structuredClone(blueprint),
  );
  assertFailure(
    () => normalizeSemanticGeometryBlueprint(pollutedPrototype),
    "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
    "plain_object_required",
  );

  for (const invalidNumber of [NaN, Infinity, -Infinity, -0, 3.5, "4"]) {
    const invalid = structuredClone(blueprint);
    delete invalid.contentHash;
    invalid.controls.nodeCount = invalidNumber;
    assertFailure(
      () => normalizeSemanticGeometryBlueprint(invalid),
      "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
      "integer_out_of_range",
    );
  }

  const wrongHash = structuredClone(blueprint);
  wrongHash.contentHash = "0".repeat(64);
  assertFailure(
    () => normalizeSemanticGeometryBlueprint(wrongHash),
    "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
    "content_hash_mismatch",
  );

  let inheritedGetterExecutions = 0;
  const inheritedDescriptors = {
    contentHash: Object.getOwnPropertyDescriptor(
      Object.prototype,
      "contentHash",
    ),
    propositionId: Object.getOwnPropertyDescriptor(
      Object.prototype,
      "propositionId",
    ),
    semanticEventGraphHash: Object.getOwnPropertyDescriptor(
      Object.prototype,
      "semanticEventGraphHash",
    ),
  };
  try {
    for (const key of Object.keys(inheritedDescriptors)) {
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        enumerable: false,
        get() {
          inheritedGetterExecutions += 1;
          throw new Error(`inherited ${key} getter must not execute`);
        },
      });
    }
    const unhashedBlueprint = structuredClone(blueprint);
    delete unhashedBlueprint.contentHash;
    assert.equal(
      normalizeSemanticGeometryBlueprint(unhashedBlueprint).contentHash,
      blueprint.contentHash,
    );
    const unhashedProgram = structuredClone(program);
    delete unhashedProgram.contentHash;
    assert.equal(
      normalizeSemanticGeometryProgram(unhashedProgram).contentHash,
      program.contentHash,
    );
    assert.deepEqual(
      compileSemanticGeometryProgram({
        geometryBlueprint: blueprint,
        primitiveParameters: sentence.primitiveParameters,
      }),
      program,
    );
  } finally {
    for (const [key, descriptor] of Object.entries(inheritedDescriptors)) {
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else delete Object.prototype[key];
    }
  }
  assert.equal(inheritedGetterExecutions, 0);

  const freshHashMutation = structuredClone(blueprint);
  delete freshHashMutation.contentHash;
  freshHashMutation.controls.density =
    freshHashMutation.controls.density === "dense" ? "sparse" : "dense";
  const normalizedMutation = normalizeSemanticGeometryBlueprint(
    freshHashMutation,
  );
  assert.notEqual(normalizedMutation.contentHash, blueprint.contentHash);
  assertFailure(
    () => validateSemanticGeometryBlueprintAgainstContext(
      normalizedMutation,
      context,
    ),
    "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
    "scene_context_binding_mismatch",
  );
  assertFailure(
    () => compileSemanticGeometryProgram({
      geometryBlueprint: normalizedMutation,
      primitiveParameters: sentence.primitiveParameters,
      propositionId: sentence.propositionId,
      semanticEventGraphHash: graph.contentHash,
    }),
    "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
    "compile_context_binding_mismatch",
  );

  assertFailure(
    () => compileSemanticGeometryProgram({
      geometryBlueprint: blueprint,
      primitiveParameters: otherSentence.primitiveParameters,
      propositionId: otherSentence.propositionId,
      semanticEventGraphHash: graph.contentHash,
    }),
    "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
    "compile_context_binding_mismatch",
  );

  const routeValue = compileRaw(
    readBaychimoWithGroundedRoute(),
    "bounded-geometry-route-adversarial",
    "prj_bounded_geometry_route_adversarial",
  );
  const routeGraph = routeValue.compiled.animationIR.content.semanticEventGraph;
  const routeSentence = routeValue.compiled.animationIR.content
    .semanticVisualSentencePlan.sentences.find(
      (candidate) => candidate.primitiveParameters.geometry.route,
    );
  assert.ok(routeSentence);
  const duplicateRouteParameters = structuredClone(
    routeSentence.primitiveParameters,
  );
  duplicateRouteParameters.geometry.route.points[1] = structuredClone(
    duplicateRouteParameters.geometry.route.points[0],
  );
  const duplicateRouteContext = {
    semanticEventGraphHash: routeGraph.contentHash,
    propositionId: routeSentence.propositionId,
    primitiveParameters: duplicateRouteParameters,
  };
  const duplicateRouteBlueprint = buildSemanticGeometryBlueprint(
    duplicateRouteContext,
  );
  const duplicateRouteProgram = compileSemanticGeometryProgram({
    geometryBlueprint: duplicateRouteBlueprint,
    ...duplicateRouteContext,
  });
  assert.equal(
    duplicateRouteProgram.nodes.length,
    duplicateRouteParameters.geometry.route.points.length,
  );
  assert.deepEqual(
    [duplicateRouteProgram.nodes[0].x, duplicateRouteProgram.nodes[0].y],
    [duplicateRouteProgram.nodes[1].x, duplicateRouteProgram.nodes[1].y],
  );
  assert.equal(duplicateRouteProgram.edges[0].kind, "dwell");
  assert.equal(
    duplicateRouteProgram.provenance,
    "approved_storyboard_layout",
  );

  const quantizedDegenerateRouteParameters = structuredClone(
    routeSentence.primitiveParameters,
  );
  quantizedDegenerateRouteParameters.geometry.route.points = [
    [0.0001, 0.0001],
    [0.0002, 0.0002],
  ];
  assertFailure(
    () => buildSemanticGeometryBlueprint({
      semanticEventGraphHash: routeGraph.contentHash,
      propositionId: routeSentence.propositionId,
      primitiveParameters: quantizedDegenerateRouteParameters,
    }),
    "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
    "geometry_degenerate",
  );

  const sparseRouteParameters = structuredClone(
    routeSentence.primitiveParameters,
  );
  delete sparseRouteParameters.geometry.route.points[1];
  assertFailure(
    () => buildSemanticGeometryBlueprint({
      semanticEventGraphHash: routeGraph.contentHash,
      propositionId: routeSentence.propositionId,
      primitiveParameters: sparseRouteParameters,
    }),
    "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
    "dense_data_array_required",
  );

  let routeGetterExecuted = false;
  const accessorRouteParameters = structuredClone(
    routeSentence.primitiveParameters,
  );
  Object.defineProperty(
    accessorRouteParameters.geometry.route.points,
    "1",
    {
      enumerable: true,
      get() {
        routeGetterExecuted = true;
        return routeSentence.primitiveParameters.geometry.route.points[1];
      },
    },
  );
  assertFailure(
    () => buildSemanticGeometryBlueprint({
      semanticEventGraphHash: routeGraph.contentHash,
      propositionId: routeSentence.propositionId,
      primitiveParameters: accessorRouteParameters,
    }),
    "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
    "dense_data_array_required",
  );
  assert.equal(routeGetterExecuted, false);

  const rawPrimitive = structuredClone(program);
  rawPrimitive.nodes[0].path = "M0 0 L1 1";
  assertFailure(
    () => normalizeSemanticGeometryProgram(rawPrimitive),
    "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
    "unsupported_field",
  );

  for (const invalidCoordinate of [NaN, Infinity, -0, 1000.5, 1001]) {
    const invalid = structuredClone(program);
    delete invalid.contentHash;
    invalid.nodes[0].x = invalidCoordinate;
    assertFailure(
      () => normalizeSemanticGeometryProgram(invalid),
      "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
      "integer_out_of_range",
    );
  }

  const tooManyNodes = structuredClone(program);
  delete tooManyNodes.contentHash;
  tooManyNodes.nodes = Array.from(
    { length: MAX_GEOMETRY_NODES + 1 },
    (_, index) => ({
      ...structuredClone(program.nodes[0]),
      id: `node_${index}`,
      x: index,
      revealOrder: Math.min(index, MAX_GEOMETRY_NODES - 1),
    }),
  );
  assertFailure(
    () => normalizeSemanticGeometryProgram(tooManyNodes),
    "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
    "array_size_invalid",
  );

  const tooManyEdges = structuredClone(program);
  delete tooManyEdges.contentHash;
  tooManyEdges.edges = Array.from(
    { length: MAX_GEOMETRY_EDGES + 1 },
    (_, index) => ({
      ...structuredClone(program.edges[0]),
      id: `edge_${index}`,
      revealOrder: Math.min(index, MAX_GEOMETRY_EDGES - 1),
    }),
  );
  assertFailure(
    () => normalizeSemanticGeometryProgram(tooManyEdges),
    "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
    "array_size_invalid",
  );

  const dangling = structuredClone(program);
  delete dangling.contentHash;
  dangling.edges[0].toNodeId = "node_missing";
  assertFailure(
    () => normalizeSemanticGeometryProgram(dangling),
    "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
    "dangling_edge",
  );

  const selfEdge = structuredClone(program);
  delete selfEdge.contentHash;
  selfEdge.edges[0].toNodeId = selfEdge.edges[0].fromNodeId;
  assertFailure(
    () => normalizeSemanticGeometryProgram(selfEdge),
    "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
    "self_edge",
  );

  const duplicatePoint = structuredClone(program);
  delete duplicatePoint.contentHash;
  duplicatePoint.nodes[1].x = duplicatePoint.nodes[0].x;
  duplicatePoint.nodes[1].y = duplicatePoint.nodes[0].y;
  assertFailure(
    () => normalizeSemanticGeometryProgram(duplicatePoint),
    "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
    "duplicate_points",
  );

  let arrayGetterExecuted = false;
  const accessorArray = structuredClone(program);
  Object.defineProperty(accessorArray.nodes, "0", {
    enumerable: true,
    get() {
      arrayGetterExecuted = true;
      return program.nodes[0];
    },
  });
  assertFailure(
    () => normalizeSemanticGeometryProgram(accessorArray),
    "ANIMATION_SEMANTIC_GEOMETRY_INVALID",
    "dense_data_array_required",
  );
  assert.equal(arrayGetterExecuted, false);
});

test("scene composition contracts reject topology injection, stripping, and fresh-hash rebinding", async () => {
  const { compileAnimationIRToHtml } = await import(
    "../renderer/hyperframes/animation-ir-adapter.mjs"
  );
  const wow = compileRaw(
    readRaw("001_wow_signal_mystery"),
    "scene-composition-adversarial",
    "prj_scene_composition_adversarial",
  );
  const graph = wow.compiled.animationIR.content.semanticEventGraph;
  const plan = wow.compiled.animationIR.content.semanticVisualSentencePlan;
  const composition = plan.sentences[0].sceneComposition;

  const extraField = structuredClone(composition);
  extraField.svg = "<path d='M0 0'/><script>unsafe()</script>";
  assertFailure(
    () => normalizeSemanticSceneComposition(extraField),
    "ANIMATION_SEMANTIC_SCENE_COMPOSITION_INVALID",
    "unsupported_or_missing_field",
  );

  const fourthModule = structuredClone(composition);
  fourthModule.modules.push(structuredClone(fourthModule.modules[2]));
  assertFailure(
    () => normalizeSemanticSceneComposition(fourthModule),
    "ANIMATION_SEMANTIC_SCENE_COMPOSITION_INVALID",
    "exactly_three_modules_required",
  );

  const thirdLink = structuredClone(composition);
  thirdLink.links.push(structuredClone(thirdLink.links[1]));
  assertFailure(
    () => normalizeSemanticSceneComposition(thirdLink),
    "ANIMATION_SEMANTIC_SCENE_COMPOSITION_INVALID",
    "exactly_two_links_required",
  );

  const sparseModules = structuredClone(composition);
  delete sparseModules.modules[1];
  assertFailure(
    () => normalizeSemanticSceneComposition(sparseModules),
    "ANIMATION_SEMANTIC_SCENE_COMPOSITION_INVALID",
    "dense_data_array_required",
  );

  const sparseLinks = structuredClone(composition);
  delete sparseLinks.links[0];
  assertFailure(
    () => normalizeSemanticSceneComposition(sparseLinks),
    "ANIMATION_SEMANTIC_SCENE_COMPOSITION_INVALID",
    "dense_data_array_required",
  );

  let moduleGetterExecuted = false;
  const accessorModules = structuredClone(composition);
  Object.defineProperty(accessorModules.modules, "1", {
    enumerable: true,
    get() {
      moduleGetterExecuted = true;
      return composition.modules[1];
    },
  });
  assertFailure(
    () => normalizeSemanticSceneComposition(accessorModules),
    "ANIMATION_SEMANTIC_SCENE_COMPOSITION_INVALID",
    "dense_data_array_required",
  );
  assert.equal(moduleGetterExecuted, false);

  for (const mutate of [
    (candidate) => { candidate.variantSeed = -0; },
    (candidate) => { candidate.modules[0].revealOrder = -0; },
  ]) {
    const nonCanonicalInteger = structuredClone(composition);
    mutate(nonCanonicalInteger);
    assertFailure(
      () => normalizeSemanticSceneComposition(nonCanonicalInteger),
      "ANIMATION_SEMANTIC_SCENE_COMPOSITION_INVALID",
      "integer_out_of_range",
    );
  }

  const rebound = (mutate) => {
    const changed = structuredClone(plan);
    delete changed.contentHash;
    mutate(changed);
    const normalized = normalizeSemanticVisualSentencePlan(changed);
    assert.equal(
      normalized.contentHash,
      semanticVisualSentencePlanContentHash(normalized),
    );
    assertFailure(
      () => validateSemanticVisualSentencePlanAgainstGraph(normalized, graph),
      "ANIMATION_SEMANTIC_VISUAL_SENTENCE_INVALID",
      "semantic_event_graph_binding_mismatch",
    );
    return normalized;
  };

  const changedLayout = rebound((changed) => {
    const target = changed.sentences[0].sceneComposition;
    target.layoutId = SEMANTIC_SCENE_COMPOSITION_LAYOUT_IDS.find(
      (layoutId) => layoutId !== target.layoutId,
    );
  });
  rebound((changed) => {
    const target = changed.sentences[0].sceneComposition;
    target.variantSeed = target.variantSeed === 0xffffffff
      ? target.variantSeed - 1
      : target.variantSeed + 1;
  });
  rebound((changed) => {
    const target = changed.sentences[0].sceneComposition.modules[1];
    const replacement = target.kind === "detail_card"
      ? ["quantity_badge", "display_quantity"]
      : ["detail_card", "cue_detail"];
    [target.kind, target.source] = replacement;
  });

  const reboundIR = structuredClone(wow.compiled.animationIR);
  reboundIR.content.semanticVisualSentencePlan = structuredClone(changedLayout);
  reboundIR.content.semantic.semanticVisualSentencePlanHash =
    changedLayout.contentHash;
  delete reboundIR.contentHash;
  assert.throws(
    () => compileAnimationIRToHtml(reboundIR, rendererSourceOptions(wow)),
    /not bound to the embedded graph/,
  );

  const invalidLink = structuredClone(composition);
  invalidLink.links[0].relation = "state";
  assertFailure(
    () => normalizeSemanticSceneComposition(invalidLink),
    "ANIMATION_SEMANTIC_SCENE_COMPOSITION_INVALID",
    "link_topology_mismatch",
  );

  const partialStrip = structuredClone(plan);
  delete partialStrip.contentHash;
  delete partialStrip.sentences[0].sceneComposition;
  assert.throws(
    () => normalizeSemanticVisualSentencePlan(partialStrip),
    { code: "ANIMATION_SEMANTIC_VISUAL_SENTENCE_INVALID" },
  );

  const compositionsOnlyStripped = structuredClone(plan);
  delete compositionsOnlyStripped.contentHash;
  delete compositionsOnlyStripped.sceneCompositionProfileId;
  compositionsOnlyStripped.sentences.forEach(
    (sentence) => delete sentence.sceneComposition,
  );
  assert.throws(
    () => normalizeSemanticVisualSentencePlan(compositionsOnlyStripped),
    { code: "ANIMATION_SEMANTIC_VISUAL_SENTENCE_INVALID" },
  );

  const fullyStrippedInput = structuredClone(plan);
  delete fullyStrippedInput.contentHash;
  delete fullyStrippedInput.sceneCompositionProfileId;
  fullyStrippedInput.sentences.forEach((sentence) => {
    delete sentence.primitiveParameters;
    delete sentence.sceneComposition;
  });
  const fullyStripped = normalizeSemanticVisualSentencePlan(
    fullyStrippedInput,
  );
  assertFailure(
    () => validateSemanticVisualSentencePlanAgainstGraph(fullyStripped, graph),
    "ANIMATION_SEMANTIC_VISUAL_SENTENCE_INVALID",
    "semantic_event_graph_binding_mismatch",
  );
});

test("approved storyboard route points produce deterministic, visibly different map geometry", async () => {
  const primitives = await import(
    "../renderer/hyperframes/primitives/semantic-sentence-primitives.mjs"
  );
  const { compileAnimationIRToHtml } = await import(
    "../renderer/hyperframes/animation-ir-adapter.mjs"
  );
  const rawA = readBaychimoWithGroundedRoute();
  const rawB = structuredClone(rawA);
  const routeA = rawA.storyboard.scenes[2].operations[0].points;
  const routeB = [
    [0.12, 0.22],
    [0.35, 0.38],
    [0.66, 0.64],
    [0.88, 0.78],
  ];
  rawB.storyboard.scenes[2].operations[0].points = routeB;
  const first = compileRaw(rawA, "grounded-route-a", "prj_grounded_route_a");
  const repeated = compileRaw(rawA, "grounded-route-a", "prj_grounded_route_a");
  const second = compileRaw(rawB, "grounded-route-b", "prj_grounded_route_b");
  const sentenceWithRoute = (compiled) => (
    compiled.animationIR.content.semanticVisualSentencePlan.sentences.find(
      (sentence) => (
        sentence.capability.grammarId === "map_motion"
        && sentence.primitiveParameters?.geometry.route
      ),
    )
  );
  const sentenceA = sentenceWithRoute(first.compiled);
  const repeatedSentence = sentenceWithRoute(repeated.compiled);
  const sentenceB = sentenceWithRoute(second.compiled);
  assert.ok(sentenceA);
  assert.ok(sentenceB);
  assert.deepEqual(sentenceA.wordSpan, sentenceB.wordSpan);
  assert.deepEqual(sentenceA.capability, sentenceB.capability);
  assert.deepEqual(sentenceA.primitiveParameters.geometry.route.points, routeA);
  assert.deepEqual(sentenceB.primitiveParameters.geometry.route.points, routeB);
  const indexA = first.compiled.animationIR.content.semanticVisualSentencePlan
    .sentences.indexOf(sentenceA);
  const indexB = second.compiled.animationIR.content.semanticVisualSentencePlan
    .sentences.indexOf(sentenceB);
  const markupA = primitives.semanticSentencePrimitiveMarkup(sentenceA, indexA);
  const repeatedMarkup = primitives.semanticSentencePrimitiveMarkup(
    repeatedSentence,
    indexA,
  );
  const markupB = primitives.semanticSentencePrimitiveMarkup(sentenceB, indexB);
  const routePath = (markup) => markup.match(
    /<path d="([^"]+)" pathLength="1" class="semantic-route-path"\/>/,
  )?.[1];
  const pathA = routePath(markupA);
  const pathB = routePath(markupB);
  assert.ok(pathA);
  assert.ok(pathB);
  assert.equal(repeatedMarkup, markupA);
  assert.notEqual(pathB, pathA);
  const mappedRouteA = routeA.map(([x, y]) => (
    `${(62 + x * 596).toFixed(3)} ${(278 + y * 380).toFixed(3)}`
  ));
  assert.equal(
    pathA,
    mappedRouteA.map(
      (point, index) => `${index ? "L" : "M"}${point}`,
    ).join(" "),
  );
  assert.equal(sentenceA.primitiveParameters.geometry.direction, "forward");
  const coordinates = pathB.match(/\d+(?:\.\d+)?/g).map(Number);
  coordinates.forEach((coordinate, index) => {
    assert.ok(
      coordinate >= (index % 2 ? 278 : 62)
      && coordinate <= (index % 2 ? 658 : 658),
    );
  });
  const compositionA = compileAnimationIRToHtml(
    first.compiled.animationIR,
    rendererSourceOptions(first),
  );
  const compositionB = compileAnimationIRToHtml(
    second.compiled.animationIR,
    rendererSourceOptions(second),
  );
  assert.notEqual(
    first.compiled.animationIR.content.semanticVisualSentencePlan.contentHash,
    second.compiled.animationIR.content.semanticVisualSentencePlan.contentHash,
  );
  assert.notEqual(first.compiled.animationIR.contentHash, second.compiled.animationIR.contentHash);
  assert.notEqual(compositionA.compositionHash, compositionB.compositionHash);
});

test("cue-grounded quantities change primitive body content without leaking legacy demo values", async () => {
  const primitives = await import(
    "../renderer/hyperframes/primitives/semantic-sentence-primitives.mjs"
  );
  const raw72 = readRaw("001_wow_signal_mystery");
  const raw41 = JSON.parse(
    JSON.stringify(raw72)
      .replaceAll("seventy-two", "forty-one")
      .replaceAll("72", "41"),
  );
  const first = compileRaw(raw72, "quantity-72", "prj_quantity_72");
  const second = compileRaw(raw41, "quantity-41", "prj_quantity_41");
  const quantified = (compiled, value) => (
    compiled.animationIR.content.semanticVisualSentencePlan.sentences.find(
      (sentence) => (
        sentence.primitiveParameters?.quantity?.value === value
        && sentence.primitiveParameters.quantity.unit
          ?.toLocaleLowerCase("en-US") === "seconds"
      ),
    )
  );
  const sentence72 = quantified(first.compiled, "seventy-two");
  const sentence41 = quantified(second.compiled, "forty-one");
  assert.ok(sentence72);
  assert.ok(sentence41);
  assert.equal(sentence72.capability.grammarId, sentence41.capability.grammarId);
  assert.equal(sentence72.capability.assetId, sentence41.capability.assetId);
  const markup72 = primitives.semanticSentencePrimitiveMarkup(sentence72, 0);
  const markup41 = primitives.semanticSentencePrimitiveMarkup(sentence41, 0);
  assert.match(markup72, />SEVENTY-TWO SECONDS/);
  assert.match(markup41, />FORTY-ONE SECONDS/);
  assert.doesNotMatch(markup72, /semantic-support-quantity/);
  assert.doesNotMatch(markup41, /semantic-support-quantity/);
  assert.doesNotMatch(markup72, /seventy-…|lengthAdjust="spacingAndGlyphs"/);
  assert.doesNotMatch(markup41, /forty-…|lengthAdjust="spacingAndGlyphs"/);
  assert.notEqual(markup41, markup72);
  assert.doesNotMatch(markup72, />1023<|>0000<|>DATE<|>INPUT<|>OUTPUT</);
  assert.doesNotMatch(markup41, />1023<|>0000<|>DATE<|>INPUT<|>OUTPUT</);
});

test("simple explainer headings and visuals remain source-bound across value substitutions", async () => {
  const primitives = await import(
    "../renderer/hyperframes/primitives/semantic-sentence-primitives.mjs"
  );
  const renderedGroup = (compiledValue, phrase) => {
    const sentences = compiledValue.compiled.animationIR.content
      .semanticVisualSentencePlan.sentences;
    const group = buildSemanticSimpleExplainerGroups(sentences).find(
      (candidate) => candidate.sentenceIndices.some(
        (index) => sentences[index].wordSpan.text.includes(phrase),
      ),
    );
    assert.ok(group, phrase);
    const anchor = sentences[group.anchorSentenceIndex];
    const groupSentences = group.sentenceIndices.map((index) => sentences[index]);
    const groupText = groupSentences.map(
      (sentence) => sentence.wordSpan.text,
    ).join(" ");
    return {
      heading: primitives.semanticSimpleExplainerHeading(
        anchor.primitiveParameters,
        groupText,
      ),
      groupText,
      markup: primitives.semanticSentencePrimitiveMarkup(
        anchor,
        group.anchorSentenceIndex,
        {
          simpleExplainerContext: {
            profileId: SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID,
            visualKind: group.visualKind,
            groupText,
            stepCount: groupSentences.length,
            visualConceptIds: groupSentences.map(
              (sentence) => sentence.primitiveParameters.visualConceptId,
            ),
            stepHeadings: groupSentences.map((sentence) => (
              primitives.semanticSimpleExplainerHeading(
                sentence.primitiveParameters,
                groupText,
                120,
              )
            )),
          },
        },
      ),
    };
  };

  const wow72 = compileRaw(
    readRaw("001_wow_signal_mystery"),
    "simple-value-duration-72",
    "prj_simple_value_duration_72",
  );
  const raw41 = JSON.parse(
    JSON.stringify(readRaw("001_wow_signal_mystery"))
      .replaceAll("seventy-two", "forty-one")
      .replaceAll("72", "41"),
  );
  const wow41 = compileRaw(
    raw41,
    "simple-value-duration-41",
    "prj_simple_value_duration_41",
  );
  const duration72 = renderedGroup(wow72, "frequency");
  const duration41 = renderedGroup(wow41, "frequency");
  assertHeadingIsSourceSubsequence(duration72.groupText, duration72.heading);
  assertHeadingIsSourceSubsequence(duration41.groupText, duration41.heading);
  assert.match(duration72.markup, />72<\/text>[\s\S]*>SECONDS<\/text>/);
  assert.match(duration41.markup, />41<\/text>[\s\S]*>SECONDS<\/text>/);
  assert.doesNotMatch(duration41.markup, />72<\/text>/);

  const baychimo = compileRaw(
    readRaw("003_baychimo_icebound_drift"),
    "simple-value-baychimo-1969",
    "prj_simple_value_baychimo_1969",
  );
  const renamedRaw = JSON.parse(
    JSON.stringify(readRaw("003_baychimo_icebound_drift"))
      .replaceAll("Baychimo", "Resolute")
      .replaceAll("BAYCHIMO", "RESOLUTE")
      .replaceAll("1969", "1987"),
  );
  const resolute = compileRaw(
    renamedRaw,
    "simple-value-resolute-1987",
    "prj_simple_value_resolute_1987",
  );
  const baychimoAbsence = renderedGroup(baychimo, "ship they had left");
  const resoluteAbsence = renderedGroup(resolute, "ship they had left");
  assertHeadingIsSourceSubsequence(
    baychimoAbsence.groupText,
    baychimoAbsence.heading,
  );
  assertHeadingIsSourceSubsequence(
    resoluteAbsence.groupText,
    resoluteAbsence.heading,
  );
  const archive1969 = renderedGroup(baychimo, "latest company archive");
  const archive1987 = renderedGroup(resolute, "latest company archive");
  assertHeadingIsSourceSubsequence(archive1969.groupText, archive1969.heading);
  assertHeadingIsSourceSubsequence(archive1987.groupText, archive1987.heading);
  assert.match(archive1969.markup, />1969</);
  assert.match(archive1987.markup, />1987</);
});

test("simple explainer headings are deterministic narration subsequences", async () => {
  const { semanticSimpleExplainerHeading } = await import(
    "../renderer/hyperframes/primitives/semantic-sentence-primitives.mjs"
  );
  const parameters = (
    visualConceptId,
    value,
    stateToken,
    detailValue = value,
  ) => ({
    visualConceptId,
    subject: { value },
    detail: {
      value: detailValue,
      sourceRef: { value: detailValue },
    },
    stateToken,
    quantity: null,
  });
  const cases = [
    {
      conceptId: "signal_frequency_band",
      source: "The frequency was never considered promising.",
      forbidden: "A FREQUENCY CONSIDERED PROMISING",
    },
    {
      conceptId: "cue_evidence_network",
      source: "Local interference caused the signal.",
      forbidden: "LOCAL INTERFERENCE BECAME LESS LIKELY",
    },
    {
      conceptId: "duration_timeline",
      source: "The signal did not last 72 seconds.",
      forbidden: "THE SIGNAL LASTED 72 SECONDS",
    },
    {
      conceptId: "cue_evidence_spotlight",
      source: "In 1977, the signal did not appear once.",
      forbidden: "SIGNAL APPEARED ONCE — LAST RECORD",
    },
    {
      conceptId: "assumption_state",
      source: "The crew had not assumed the ship had sunk.",
      forbidden: "THE CREW ASSUMED THE SHIP HAD SUNK",
    },
    {
      conceptId: "observation_sequence",
      source: "Nobody boarded the ship.",
      forbidden: "PEOPLE SAW AND BOARDED THE SHIP",
    },
    {
      conceptId: "cue_evidence_spotlight",
      source: "The failure was never haunted.",
      forbidden: "THE FAILURE LOOKED MYSTERIOUS",
    },
    {
      conceptId: "hypothesis_rejection",
      source: "The signal repeated twice but was never verified.",
      forbidden: "IT NEVER REPEATED — UNRESOLVED",
    },
    {
      conceptId: "hypothesis_rejection",
      source: "The telescope beam crossed the source without the signal strength tracking it.",
      forbidden: "SIGNAL STRENGTH TRACKED THE BEAM",
    },
    {
      conceptId: "hypothesis_rejection",
      source: "It was not a supernatural ghost ship, but no drift was documented.",
      detail: "no drift was documented.",
      forbidden: "DOCUMENTED DRIFT — NOT A GHOST SHIP",
    },
    {
      conceptId: "route_trace",
      source: "Without a crew, the vessel drifted toward Hawaii.",
      forbidden: "EMPTY SHIP DRIFTED WITH ARCTIC ICE",
    },
    {
      conceptId: "observation_sequence",
      source: "People spotted the abandoned steamer for the first time.",
      forbidden: "HUNTERS SPOTTED THE SHIP AGAIN",
    },
    {
      conceptId: "assumption_state",
      source: "They spotted the ship before they assumed it had sunk.",
      forbidden: "ASSUMED SUNK — THEN SPOTTED AGAIN",
    },
    {
      conceptId: "hypothesis_rejection",
      source: "The alarm stopped, not time itself.",
      forbidden: "TIME ITSELF DID NOT RESET",
    },
    {
      conceptId: "future_rollover_timeline",
      source: "A future rollover is due in 2038.",
      forbidden: "NEXT LEGACY ROLLOVER: 2038",
    },
    {
      conceptId: "finite_counter_wrap",
      source: "The value reset to zero.",
      forbidden: "THE COUNTER RESET TO 0",
    },
    {
      conceptId: "observation_sequence",
      source: "Sailors boarded the vessel.",
      forbidden: "SAILORS BOARDED THE SHIP",
    },
    {
      conceptId: "duration_timeline",
      source: "One signal was near a frequency researchers considered promising. Another signal lasted 72 seconds.",
      detail: "One signal was near a frequency researchers considered promising.",
      forbidden: "72 SECONDS NEAR A PROMISING FREQUENCY",
    },
    {
      conceptId: "observation_sequence",
      source: "People spotted a cargo ship beside an abandoned steamer.",
      forbidden: "ABANDONED STEAMER WAS SPOTTED",
    },
    {
      conceptId: "counter_recurrence",
      source: "The counter covers 20 years. Before that, it rolled over.",
      detail: "The counter covers 20 years.",
      forbidden: "~20 YEARS, THEN COUNTER ROLLED OVER",
    },
  ];
  for (const [index, value] of cases.entries()) {
    const input = parameters(
      value.conceptId,
      value.source.toLocaleLowerCase("en-US"),
      "SOURCE_LOCKED",
      value.detail || value.source,
    );
    const heading = semanticSimpleExplainerHeading(input, value.source);
    assertHeadingIsSourceSubsequence(
      value.source,
      heading,
      `source-locked-heading:${index}`,
    );
    assert.equal(heading.length <= 40, true);
    assert.notEqual(heading, value.forbidden, value.source);
    assert.equal(
      semanticSimpleExplainerHeading(input, value.source),
      heading,
      `deterministic-heading:${index}`,
    );
  }

  const abbreviationSource =
    "Dr. Smith recorded the signal. It never repeated.";
  const abbreviationHeading = semanticSimpleExplainerHeading(
    parameters(
      "observation_sequence",
      abbreviationSource,
      "RECORDED",
      "Dr. Smith recorded the signal.",
    ),
    abbreviationSource,
  );
  assertHeadingIsSourceSubsequence(abbreviationSource, abbreviationHeading);
  assert.match(abbreviationHeading, /DR\. SMITH RECORDED THE SIGNAL/);
  assert.doesNotMatch(abbreviationHeading, /NEVER REPEATED/);

  const acronymSource = "The U.S. signal vanished. It returned.";
  const acronymHeading = semanticSimpleExplainerHeading(
    parameters(
      "observation_sequence",
      acronymSource,
      "RECORDED",
      "The U.S. signal vanished.",
    ),
    acronymSource,
  );
  assertHeadingIsSourceSubsequence(acronymSource, acronymHeading);
  assert.match(acronymHeading, /U\.S\. SIGNAL VANISHED/);
  assert.doesNotMatch(acronymHeading, /RETURNED/);

  const terminalInitialismSource =
    "The ship returned to the U.S. Nobody followed.";
  const terminalInitialismHeading = semanticSimpleExplainerHeading(
    parameters(
      "observation_sequence",
      terminalInitialismSource,
      "RECORDED",
      "The ship returned to the U.S.",
    ),
    terminalInitialismSource,
  );
  assertHeadingIsSourceSubsequence(
    terminalInitialismSource,
    terminalInitialismHeading,
  );
  assert.match(terminalInitialismHeading, /SHIP RETURNED TO THE U\.S/);
  assert.doesNotMatch(terminalInitialismHeading, /NOBODY/);

  for (const source of [
    "The signal, despite repeated claims, didn't actually last seventy two seconds during the test.",
    "The device couldn't possibly display the wrong date under ordinary conditions.",
  ]) {
    const heading = semanticSimpleExplainerHeading(
      parameters("observation_sequence", source, "REJECTED"),
      source,
    );
    assertHeadingIsSourceSubsequence(source, heading);
    assert.match(heading, /(?:DIDN'T|COULDN'T)/);
    assert.match(heading, /…/);
  }

  for (const [source, required] of [
    [
      "The signal appeared to repeat under every preliminary check before failing to repeat during the controlled test.",
      /FAILING TO/,
    ],
    [
      "The signal seemed well supported by all early reports despite lacking independent verification later.",
      /LACKING/,
    ],
    [
      "The receiver looked correct in every preview but was unable to display the verified date.",
      /UNABLE TO/,
    ],
  ]) {
    const heading = semanticSimpleExplainerHeading(
      parameters("observation_sequence", source, "REJECTED", source),
      source,
    );
    assertHeadingIsSourceSubsequence(source, heading);
    assert.match(heading, required);
    assert.match(heading, /…/);
  }

  const unsafeSeparatedPolaritySources = [
    "The receiver was not, after many independent checks and careful reviews, unable to display the date.",
    "The archive did not, according to every investigator who reviewed it, lack a verified chain.",
    "The signal did not, despite every severe test and independent challenge, fail to repeat.",
    "Engineers did not find electromagneticinterference capable of making the old receiver unable to show the right date.",
    "Researchers did not find electromagneticinterference sufficient to leave the archive lacking any chain at all.",
    "Analysts did not judge electromagneticinterference enough to make the signal fail to repeat in the test.",
    "The receiver wasnʼt after extensive independent verification unable to display the correct date.",
    "The archive didnʼt after exhaustive independent review lack a verified chain of custody.",
    "The signal couldnʼt after weeks of controlled testing fail to repeat in the final trial.",
    "The signal was not—after extensive independent verification—unable—to display the correct date.",
  ];
  for (const source of unsafeSeparatedPolaritySources) {
    assert.throws(
      () => semanticSimpleExplainerHeading(
        parameters("observation_sequence", source, "REJECTED", source),
        source,
      ),
      /no safe whole-token excerpt/,
      source,
    );
  }

  const compactDoubleNegation =
    "The receiver was not unable to show it.";
  const compactDoubleNegationHeading = semanticSimpleExplainerHeading(
    parameters(
      "observation_sequence",
      compactDoubleNegation,
      "REJECTED",
      compactDoubleNegation,
    ),
    compactDoubleNegation,
  );
  assertHeadingIsSourceSubsequence(
    compactDoubleNegation,
    compactDoubleNegationHeading,
  );
  assert.match(compactDoubleNegationHeading, /NOT UNABLE TO/);

  for (const source of [
    `${"μαΐου ".repeat(12)}το σήμα επαναλήφθηκε αλλά δεν επιβεβαιώθηκε`.trim(),
    "Oﬃcial records and oﬃce logs and aﬃdavits described the mysterious signal after review as extraterrestrial, allegedly.",
  ]) {
    assert.equal(source.length <= 120, true);
    const heading = semanticSimpleExplainerHeading(
      parameters("observation_sequence", source, "SOURCE_LOCKED", source),
      source,
      120,
    );
    assert.equal(heading, source.toUpperCase().replace(/\s+/g, " "));
    assert.doesNotMatch(heading, /…/);
  }

  for (const [source, required] of [
    [
      "The signal failed repeatedly to appear during the controlled test after seeming completely reliable.",
      /FAILED REPEATEDLY TO/,
    ],
    [
      "The receiver was unable at first to display the correct date despite later succeeding.",
      /UNABLE AT FIRST TO/,
    ],
    [
      "The signal appeared credible throughout early review although independent verification remained impossible.",
      /IMPOSSIBLE/,
    ],
    [
      "The archive remained unverified despite extensive independent review by multiple investigators.",
      /UNVERIFIED/,
    ],
  ]) {
    const heading = semanticSimpleExplainerHeading(
      parameters("observation_sequence", source, "SOURCE_LOCKED", source),
      source,
    );
    assertHeadingIsSourceSubsequence(source, heading);
    assert.match(heading, required);
    assert.equal(heading.length <= 40, true);
  }

  const quotedSource =
    '"The signal vanished." Witnesses searched again.';
  const quotedHeading = semanticSimpleExplainerHeading(
    parameters(
      "observation_sequence",
      quotedSource,
      "RECORDED",
      "The signal vanished.",
    ),
    quotedSource,
  );
  assertHeadingIsSourceSubsequence(quotedSource, quotedHeading);
  assert.match(quotedHeading, /SIGNAL VANISHED/);
  assert.doesNotMatch(quotedHeading, /WITNESSES/);

  for (const [source, detail, forbidden] of [
    [
      "The signal appeared。 It never repeated.",
      "The signal appeared。",
      /NEVER REPEATED/,
    ],
    [
      "The signal appeared！ Nobody verified it.",
      "The signal appeared！",
      /NOBODY VERIFIED/,
    ],
    [
      "The witness said «It vanished.» Nobody returned.",
      "The witness said «It vanished.»",
      /NOBODY RETURNED/,
    ],
    [
      "The signal came from Mt. Wilson before it vanished.",
      "The signal came from Mt. Wilson before it vanished.",
      /NEVER REPEATED/,
    ],
    [
      "J. Allen recorded the signal before dawn.",
      "J. Allen recorded the signal before dawn.",
      /NEVER REPEATED/,
    ],
    [
      "At 3 p.m. NASA detected the burst over Ohio.",
      "At 3 p.m. NASA detected the burst over Ohio.",
      /NEVER REPEATED/,
    ],
  ]) {
    const heading = semanticSimpleExplainerHeading(
      parameters("observation_sequence", source, "RECORDED", detail),
      source,
    );
    assertHeadingIsSourceSubsequence(detail, heading);
    assert.doesNotMatch(heading, forbidden);
  }

  assert.throws(
    () => semanticSimpleExplainerHeading(
      {},
      "A report by the U.S. Navy confirmed the signal.",
    ),
    /exact source-bound proposition/,
  );
  assert.throws(
    () => semanticSimpleExplainerHeading(
      parameters(
        "observation_sequence",
        "The signal appeared.",
        "RECORDED",
        "A different signal appeared.",
      ),
      "The signal appeared.",
    ),
    /exact source-bound proposition/,
  );

  assert.throws(
    () => semanticSimpleExplainerHeading(
      parameters(
        "observation_sequence",
        "Alphaalphabeticalwordlonglonglonglonglonglong Betaalphabeticalwordlonglonglonglonglonglong.",
        "RECORDED",
      ),
      "Alphaalphabeticalwordlonglonglonglonglonglong Betaalphabeticalwordlonglonglonglonglonglong.",
    ),
    /no safe whole-token excerpt/,
  );
});

test("unverified repeated concepts stay in distinct one-step narration scenes", async () => {
  const { compileAnimationIRToHtml } = await import(
    "../renderer/hyperframes/animation-ir-adapter.mjs"
  );
  const primitives = await import(
    "../renderer/hyperframes/primitives/semantic-sentence-primitives.mjs"
  );
  const cases = [
    {
      visualKind: "state_change",
      spokenText:
        "The display changed from green to amber. The display changed from amber to red.",
    },
    {
      visualKind: "cause_effect",
      spokenText:
        "Heavy rain caused the launch time to change. Strong wind caused the launch route to change.",
    },
  ];
  for (const [caseIndex, value] of cases.entries()) {
    const raw = readRaw("002_gps_week_rollover");
    raw.script.beats[2].spokenText = value.spokenText;
    const compiledValue = compileRaw(
      raw,
      `generic-second-step-${value.visualKind}`,
      `prj_generic_second_step_${caseIndex}`,
    );
    const { animationIR } = compiledValue.compiled;
    const sentences = animationIR.content.semanticVisualSentencePlan.sentences;
    const groups = buildSemanticSimpleExplainerGroups(sentences);
    const beatGroups = groups.filter(
      (candidate) => candidate.beatId === "beat_evidence",
    );
    assert.ok(beatGroups.length >= 2, value.visualKind);
    for (const group of beatGroups) {
      assert.equal(group.sentenceIndices.length, 1, value.visualKind);
      const anchor = sentences[group.anchorSentenceIndex];
      const groupText = anchor.wordSpan.text;
      const heading = primitives.semanticSimpleExplainerHeading(
        anchor.primitiveParameters,
        groupText,
        120,
      );
      const markup = primitives.semanticSentencePrimitiveMarkup(
        anchor,
        group.anchorSentenceIndex,
        {
          simpleExplainerContext: {
            profileId: SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID,
            visualKind: group.visualKind,
            groupText,
            stepCount: 1,
            visualConceptIds: [
              anchor.primitiveParameters.visualConceptId,
            ],
            stepHeadings: [heading],
          },
        },
      );
      assert.match(markup, /data-simple-visible-step-count="1"/);
      assert.doesNotMatch(markup, /semantic-step-secondary/);
    }
    const composition = compileAnimationIRToHtml(
      animationIR,
      rendererSourceOptions(compiledValue),
    );
    assert.match(
      composition.html,
      /const secondaryProgress=secondaryStartFrame!==null/,
      value.visualKind,
    );
  }
});

test("simple explainer preserves narration order and every validated pair renders two steps", async () => {
  const { compileAnimationIRToHtml } = await import(
    "../renderer/hyperframes/animation-ir-adapter.mjs"
  );
  const primitives = await import(
    "../renderer/hyperframes/primitives/semantic-sentence-primitives.mjs"
  );
  const markupForGroup = (sentences, group) => {
    const groupSentences = group.sentenceIndices.map((index) => sentences[index]);
    const groupText = groupSentences.map(
      (sentence) => sentence.wordSpan.text,
    ).join(" ");
    const anchor = sentences[group.anchorSentenceIndex];
    return primitives.semanticSentencePrimitiveMarkup(
      anchor,
      group.anchorSentenceIndex,
      {
        simpleExplainerContext: {
          profileId: SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID,
          visualKind: group.visualKind,
          groupText,
          stepCount: groupSentences.length,
          visualConceptIds: groupSentences.map(
            (sentence) => sentence.primitiveParameters.visualConceptId,
          ),
          stepHeadings: groupSentences.map((sentence) => (
            primitives.semanticSimpleExplainerHeading(
              sentence.primitiveParameters,
              groupText,
              120,
            )
          )),
        },
      },
    );
  };

  const reverseRaw = readBaychimoWithGroundedRoute();
  const reverseText =
    "Local hunters spotted the ship before the crew assumed it had sunk.";
  reverseRaw.script.beats.find(
    (beat) => beat.id === "beat_context",
  ).spokenText = reverseText;
  reverseRaw.claimLedger.claims.find(
    (claim) => claim.id === "claim_reappearance",
  ).text = reverseText;
  const reverse = compileRaw(
    reverseRaw,
    "simple-order-reversal",
    "prj_simple_order_reversal",
  );
  const reverseSentences = reverse.compiled.animationIR.content
    .semanticVisualSentencePlan.sentences;
  const reverseGroups = buildSemanticSimpleExplainerGroups(reverseSentences, {
    fps: reverse.compiled.animationIR.fps,
  }).filter((group) => group.beatId === "beat_context");
  assert.ok(reverseGroups.length >= 1);
  assert.ok(reverseGroups.every((group) => group.sentenceIndices.length === 1));
  for (const group of reverseGroups) {
    const markup = markupForGroup(reverseSentences, group);
    assert.match(markup, /data-simple-visible-step-count="1"/);
    assert.doesNotMatch(markup, /assumption_to_sighting|SPOTTED AGAIN/);
  }

  const finiteRaw = readRaw("002_gps_week_rollover");
  finiteRaw.script.beats.find(
    (beat) => beat.id === "beat_context",
  ).spokenText =
    "The legacy civil signal stores its week number in ten bits, and the counter has a finite range.";
  const finite = compileRaw(
    finiteRaw,
    "simple-finite-range",
    "prj_simple_finite_range",
  );
  const finiteSentences = finite.compiled.animationIR.content
    .semanticVisualSentencePlan.sentences;
  const finiteGroup = buildSemanticSimpleExplainerGroups(finiteSentences, {
    fps: finite.compiled.animationIR.fps,
  }).find((group) => group.sentenceIndices.some(
    (index) => finiteSentences[index].wordSpan.text.includes("ten bits"),
  ));
  assert.ok(finiteGroup);
  assert.equal(finiteGroup.sentenceIndices.length, 2);
  const finiteMarkup = markupForGroup(finiteSentences, finiteGroup);
  assert.match(finiteMarkup, /data-simple-visible-step-count="2"/);
  assert.match(finiteMarkup, /semantic-step-secondary/);
  assert.match(finiteMarkup, />FINITE RANGE<\/text>/);
  assert.doesNotThrow(() => compileAnimationIRToHtml(
    finite.compiled.animationIR,
    rendererSourceOptions(finite),
  ));

  const durationBase = compileRaw(
    readRaw("001_wow_signal_mystery"),
    "simple-duration-unit",
    "prj_simple_duration_unit",
  );
  const durationSentences = durationBase.compiled.animationIR.content
    .semanticVisualSentencePlan.sentences;
  const durationGroup = buildSemanticSimpleExplainerGroups(durationSentences, {
    fps: durationBase.compiled.animationIR.fps,
  }).find((group) => group.sentenceIndices.map(
    (index) => durationSentences[index].primitiveParameters.visualConceptId,
  ).join(">") === "signal_frequency_band>duration_timeline");
  assert.ok(durationGroup);
  const durationAnchor = durationSentences[durationGroup.anchorSentenceIndex];
  const minuteMarkup = primitives.semanticSentencePrimitiveMarkup(
    durationAnchor,
    durationGroup.anchorSentenceIndex,
    {
      simpleExplainerContext: {
        profileId: SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID,
        visualKind: durationGroup.visualKind,
        groupText: "A signal arrived near a promising frequency and lasted two minutes.",
        stepCount: 2,
        visualConceptIds: ["signal_frequency_band", "duration_timeline"],
        stepHeadings: ["PROMISING FREQUENCY", "LASTED TWO MINUTES"],
      },
    },
  );
  assert.match(minuteMarkup, />2<\/text>[\s\S]*>MINUTES<\/text>/);

  const directMarkup = primitives.semanticSentencePrimitiveMarkup(
    finiteSentences[finiteGroup.anchorSentenceIndex],
    finiteGroup.anchorSentenceIndex,
  );
  assert.doesNotMatch(
    directMarkup,
    /data-semantic-presentation-profile-id=/,
  );
});

test("multiword number phrases keep one exact value span and their unit", () => {
  const value = "The signal continued for twenty four hours.";
  const quantities = quantityTokens({
    sourceType: "beat",
    sourceId: "beat_context",
    operationIndex: null,
    field: "spokenText",
    startOffset: 0,
    endOffset: value.length,
    value,
  });
  assert.equal(quantities.length, 1);
  assert.equal(quantities[0].value, "twenty four");
  assert.equal(quantities[0].unit, "hours");
  assert.equal(
    value.slice(
      quantities[0].valueSourceRef.startOffset,
      quantities[0].valueSourceRef.endOffset,
    ),
    "twenty four",
  );
  assert.equal(
    value.slice(
      quantities[0].unitSourceRef.startOffset,
      quantities[0].unitSourceRef.endOffset,
    ),
    "hours",
  );

  const conjunctionValue = "The archive covers one hundred and twenty years.";
  const conjunctionQuantities = quantityTokens({
    sourceType: "beat",
    sourceId: "beat_evidence",
    operationIndex: null,
    field: "spokenText",
    startOffset: 0,
    endOffset: conjunctionValue.length,
    value: conjunctionValue,
  });
  assert.equal(conjunctionQuantities.length, 1);
  assert.equal(
    conjunctionQuantities[0].value,
    "one hundred and twenty",
  );
  assert.equal(conjunctionQuantities[0].unit, "years");

  const hyphenatedValue = "The message uses a 32-bit field.";
  const hyphenatedQuantities = quantityTokens({
    sourceType: "beat",
    sourceId: "beat_hyphenated_bits",
    operationIndex: null,
    field: "spokenText",
    startOffset: 0,
    endOffset: hyphenatedValue.length,
    value: hyphenatedValue,
  });
  assert.equal(hyphenatedQuantities.length, 1);
  assert.equal(hyphenatedQuantities[0].value, "32");
  assert.equal(hyphenatedQuantities[0].unit, "bit");
  assert.equal(
    hyphenatedValue.slice(
      hyphenatedQuantities[0].valueSourceRef.startOffset,
      hyphenatedQuantities[0].valueSourceRef.endOffset,
    ),
    "32",
  );
  assert.equal(
    hyphenatedValue.slice(
      hyphenatedQuantities[0].unitSourceRef.startOffset,
      hyphenatedQuantities[0].unitSourceRef.endOffset,
    ),
    "bit",
  );
});

test("generalized graph semantics cannot be rebound or downgraded with fresh hashes", async () => {
  const { compileAnimationIRToHtml } = await import(
    "../renderer/hyperframes/animation-ir-adapter.mjs"
  );
  const { compileSemanticSentenceAnimationIRToHtml } = await import(
    "../renderer/hyperframes/semantic-sentence-animation.mjs"
  );
  const wow = compileRaw(
    readRaw("001_wow_signal_mystery"),
    "graph-binding-adversarial",
    "prj_graph_binding_adversarial",
  );
  const graph = wow.compiled.animationIR.content.semanticEventGraph;
  const graphFailure = (mutate, reason = "generalized_story_binding_mismatch") => {
    const changed = structuredClone(graph);
    delete changed.contentHash;
    mutate(changed);
    assertFailure(
      () => validateSemanticEventGraphAgainstDraft(changed, {
        draft: wow.draft,
        timingContext: wow.timingContext,
      }),
      "ANIMATION_SEMANTIC_EVENT_INVALID",
      reason,
    );
  };

  graphFailure((changed) => {
    changed.propositions[1].primitivePayload.headline = structuredClone(
      changed.propositions[0].primitivePayload.headline,
    );
  });
  const quantified = graph.propositions.filter(
    (proposition) => proposition.primitivePayload.displayQuantity,
  );
  assert.ok(quantified.length >= 2);
  graphFailure((changed) => {
    const donor = changed.propositions.find(
      (proposition) => proposition.id === quantified[0].id,
    );
    const target = changed.propositions.find(
      (proposition) => proposition.id === quantified[1].id,
    );
    target.primitivePayload.displayQuantity = structuredClone(
      donor.primitivePayload.displayQuantity,
    );
  }, "concept_grounding_mismatch");
  graphFailure((changed) => {
    changed.propositions[0].polarity = changed.propositions[0].polarity
      === "affirmed" ? "negated" : "affirmed";
  });
  graphFailure(
    (changed) => changed.propositions.forEach(
      (proposition) => delete proposition.primitivePayload,
    ),
    "payload_required_for_every_proposition",
  );
  graphFailure(
    (changed) => delete changed.primitivePayloadProfileId,
    "payload_profile_marker_required",
  );
  graphFailure(
    (changed) => {
      delete changed.primitivePayloadProfileId;
      changed.propositions.forEach(
        (proposition) => delete proposition.primitivePayload,
      );
    },
    "unparameterized_graph_not_allowlisted",
  );

  assert.throws(
    () => validateAnimationIR(wow.compiled.animationIR),
    /trusted validation context/,
  );
  assert.equal(
    validateAnimationIR(
      wow.compiled.animationIR,
      rendererSourceOptions(wow),
    ).contentHash,
    wow.compiled.animationIR.contentHash,
  );
  assert.throws(
    () => validateAnimationIR(wow.compiled.animationIR, {
      trustedSemanticEventGraphHash: graph.contentHash,
    }),
    /trusted validation context/,
  );
  assert.throws(
    () => compileAnimationIRToHtml(wow.compiled.animationIR),
    /trusted validation context/,
  );
  assert.throws(
    () => compileAnimationIRToHtml(wow.compiled.animationIR, {
      trustedSemanticEventGraphHash: graph.contentHash,
    }),
    /trusted validation context/,
  );

  const forgedGraphInput = structuredClone(graph);
  delete forgedGraphInput.contentHash;
  const forgedHeadline =
    forgedGraphInput.propositions[0].primitivePayload.headline;
  forgedHeadline.value = "FORGED SOURCE";
  forgedHeadline.sourceRef.value = forgedHeadline.value;
  forgedHeadline.sourceRef.endOffset =
    forgedHeadline.sourceRef.startOffset + forgedHeadline.value.length;
  const forgedGraph = normalizeSemanticEventGraph(forgedGraphInput);
  const forgedPlan = buildSemanticVisualSentencePlan(forgedGraph);
  const forgedIR = structuredClone(wow.compiled.animationIR);
  forgedIR.content.semanticEventGraph = structuredClone(forgedGraph);
  forgedIR.content.semanticVisualSentencePlan = structuredClone(forgedPlan);
  forgedIR.content.semantic.semanticEventGraphHash = forgedGraph.contentHash;
  forgedIR.content.semantic.semanticVisualSentencePlanHash =
    forgedPlan.contentHash;
  const forgedSceneDslPlan =
    buildDeterministicSemanticAnimationSceneDslPlan({
      semanticEventGraph: forgedGraph,
      semanticVisualSentencePlan: forgedPlan,
    });
  forgedIR.content.semanticAnimationSceneDslPlan =
    structuredClone(forgedSceneDslPlan);
  forgedIR.content.semantic.semanticAnimationSceneDslPlanHash =
    forgedSceneDslPlan.contentHash;
  delete forgedIR.contentHash;
  assert.throws(
    () => validateAnimationIR(forgedIR),
    /trusted validation context/,
  );
  assert.throws(
    () => validateAnimationIR(forgedIR, {
      trustedSemanticEventGraphHash: graph.contentHash,
    }),
    /trusted validation context/,
  );
  assert.throws(
    () => validateAnimationIR(forgedIR, rendererSourceOptions(wow)),
    { code: "ANIMATION_SEMANTIC_EVENT_INVALID" },
  );
  assert.throws(
    () => compileAnimationIRToHtml(forgedIR),
    /trusted validation context/,
  );
  assert.throws(
    () => compileAnimationIRToHtml(forgedIR, {
      trustedSemanticEventGraphHash: graph.contentHash,
    }),
    /trusted validation context/,
  );
  assert.throws(
    () => compileAnimationIRToHtml(forgedIR, rendererSourceOptions(wow)),
    /do not match the trusted context/,
  );

  const strippedPlanInput = structuredClone(
    wow.compiled.animationIR.content.semanticVisualSentencePlan,
  );
  delete strippedPlanInput.contentHash;
  delete strippedPlanInput.sceneCompositionProfileId;
  strippedPlanInput.sentences.forEach((sentence) => {
    delete sentence.primitiveParameters;
    delete sentence.sceneComposition;
  });
  const strippedPlan = normalizeSemanticVisualSentencePlan(strippedPlanInput);
  assertFailure(
    () => validateSemanticVisualSentencePlanAgainstGraph(strippedPlan, graph),
    "ANIMATION_SEMANTIC_VISUAL_SENTENCE_INVALID",
    "semantic_event_graph_binding_mismatch",
  );
  const strippedIR = structuredClone(wow.compiled.animationIR);
  strippedIR.content.semanticVisualSentencePlan = structuredClone(strippedPlan);
  strippedIR.content.semantic.semanticVisualSentencePlanHash =
    strippedPlan.contentHash;
  assert.throws(
    () => compileAnimationIRToHtml(strippedIR, rendererSourceOptions(wow)),
    /not bound to the embedded graph|composition profile does not match/,
  );

  const fullyStrippedGraphInput = structuredClone(graph);
  delete fullyStrippedGraphInput.contentHash;
  delete fullyStrippedGraphInput.primitivePayloadProfileId;
  fullyStrippedGraphInput.propositions.forEach(
    (proposition) => delete proposition.primitivePayload,
  );
  const fullyStrippedGraph = normalizeSemanticEventGraph(
    fullyStrippedGraphInput,
  );
  const fullyStrippedPlanInput = structuredClone(
    wow.compiled.animationIR.content.semanticVisualSentencePlan,
  );
  delete fullyStrippedPlanInput.contentHash;
  fullyStrippedPlanInput.bindings.semanticEventGraphHash =
    fullyStrippedGraph.contentHash;
  delete fullyStrippedPlanInput.sceneCompositionProfileId;
  fullyStrippedPlanInput.sentences.forEach((sentence) => {
    delete sentence.primitiveParameters;
    delete sentence.sceneComposition;
  });
  const fullyStrippedPlan = normalizeSemanticVisualSentencePlan(
    fullyStrippedPlanInput,
  );
  const fullyStrippedIR = structuredClone(wow.compiled.animationIR);
  fullyStrippedIR.content.semanticEventGraph =
    structuredClone(fullyStrippedGraph);
  fullyStrippedIR.content.semanticVisualSentencePlan =
    structuredClone(fullyStrippedPlan);
  fullyStrippedIR.content.semantic.semanticEventGraphHash =
    fullyStrippedGraph.contentHash;
  fullyStrippedIR.content.semantic.semanticVisualSentencePlanHash =
    fullyStrippedPlan.contentHash;
  delete fullyStrippedIR.content.semanticAnimationSceneDslPlan;
  delete fullyStrippedIR.content.semantic
    .semanticAnimationSceneDslPlanHash;
  fullyStrippedIR.contentHash = undefined;
  assert.throws(
    () => validateAnimationIR(fullyStrippedIR),
    /Unparameterized semantic graph is not an approved checked profile/,
  );
  assert.throws(
    () => compileAnimationIRToHtml(fullyStrippedIR),
    /Unparameterized semantic graph is not an approved checked profile/,
  );
  const graphlessStrippedIR = structuredClone(fullyStrippedIR);
  delete graphlessStrippedIR.content.semanticEventGraph;
  assert.throws(
    () => compileSemanticSentenceAnimationIRToHtml(graphlessStrippedIR),
    /Graphless sentence plan is not an approved checked profile/,
  );
});

test("sentence primitives follow the current cue, preserve units, and use semantic geometry", async () => {
  const primitives = await import(
    "../renderer/hyperframes/primitives/semantic-sentence-primitives.mjs"
  );
  const gps = compileRaw(
    readRaw("002_gps_week_rollover"),
    "cue-primitive-regression",
    "prj_cue_primitive_regression",
  );
  const sentences =
    gps.compiled.animationIR.content.semanticVisualSentencePlan.sentences;
  const rollover = sentences.find(
    (sentence) => sentence.wordSpan.text.includes("2038"),
  );
  assert.ok(rollover);
  assert.equal(rollover.primitiveParameters.quantity.value, "2038");
  assert.equal(rollover.capability.assetId, "timeline_axis");
  assert.equal(rollover.capability.grammarId, "chronology_accumulation");
  assert.equal(rollover.primitiveParameters.stateToken, "UPCOMING");
  assert.match(
    primitives.semanticSentencePrimitiveMarkup(
      rollover,
      sentences.indexOf(rollover),
    ),
    /data-geometry-kind="chronology_records"[\s\S]*>2038</,
  );

  const resetToZero = sentences.find(
    (sentence) => sentence.wordSpan.text.includes("reset to zero"),
  );
  assert.ok(resetToZero);
  assert.equal(resetToZero.capability.grammarId, "finite_cycle");
  assert.equal(resetToZero.primitiveParameters.quantity.value, "zero");
  const resetMarkup = primitives.semanticSentencePrimitiveMarkup(
    resetToZero,
    sentences.indexOf(resetToZero),
  );
  assert.match(resetMarkup, /data-finite-counter-concept="wrap"/);
  assert.match(resetMarkup, />LAST VALUE</);
  assert.match(resetMarkup, />RESET TO</);
  assert.match(resetMarkup, />ZERO<\/text>/);

  const pronounRollover = sentences.find(
    (sentence) => sentence.wordSpan.text.includes("When it rolled over"),
  );
  assert.ok(pronounRollover);
  assert.equal(pronounRollover.capability.assetId, "finite_counter");
  assert.equal(
    pronounRollover.primitiveParameters.visualConceptId,
    "counter_recurrence",
  );

  const numberReset = sentences.find(
    (sentence) => sentence.wordSpan.text.includes("The number reset"),
  );
  assert.ok(numberReset);
  assert.equal(numberReset.capability.assetId, "finite_counter");
  assert.equal(
    numberReset.primitiveParameters.visualConceptId,
    "finite_counter_wrap",
  );

  const distractorRaw = readRaw("002_gps_week_rollover");
  distractorRaw.script.beats[0].spokenText =
    distractorRaw.script.beats[0].spokenText.replace(
      "the legacy GPS week counter reset to zero",
      "the legacy GPS week counter waited twenty years, then reset to zero",
    );
  const distractorA = compileRaw(
    distractorRaw,
    "transition-target-distractors",
    "prj_transition_target_distractors",
  );
  const distractorB = compileRaw(
    structuredClone(distractorRaw),
    "transition-target-distractors",
    "prj_transition_target_distractors",
  );
  assert.equal(
    distractorA.compiled.animationIR.contentHash,
    distractorB.compiled.animationIR.contentHash,
  );
  const distractorReset = distractorA.compiled.animationIR.content
    .semanticVisualSentencePlan.sentences.find(
      (sentence) => sentence.wordSpan.text.includes("reset to zero"),
    );
  assert.ok(distractorReset);
  assert.equal(distractorReset.primitiveParameters.quantity.value, "zero");
  const distractorProposition = distractorA.compiled.animationIR.content
    .semanticEventGraph.propositions.find(
      (proposition) => proposition.id === distractorReset.propositionId,
    );
  assert.ok(distractorProposition.quantities.length >= 4);
  assert.ok(distractorProposition.quantities.some(
    (quantity) => quantity.value === "zero",
  ));

  const fromToRaw = readRaw("002_gps_week_rollover");
  fromToRaw.script.beats[0].spokenText =
    fromToRaw.script.beats[0].spokenText.replace(
      "counter reset to zero",
      "counter reset from 1023 to zero",
    );
  const fromTo = compileRaw(
    fromToRaw,
    "transition-from-to-target",
    "prj_transition_from_to_target",
  );
  const fromToReset = fromTo.compiled.animationIR.content
    .semanticVisualSentencePlan.sentences.find(
      (sentence) => sentence.wordSpan.text.includes("reset from 1023 to zero"),
    );
  assert.ok(fromToReset);
  assert.equal(fromToReset.primitiveParameters.quantity.value, "zero");

  const newerMessages = sentences.find(
    (sentence) => sentence.wordSpan.text.includes("newer navigation messages"),
  );
  assert.ok(newerMessages);
  assert.equal(
    newerMessages.primitiveParameters.detail.value,
    newerMessages.wordSpan.text,
  );
  assert.equal(
    newerMessages.primitiveParameters.detail.sourceRef.value,
    newerMessages.wordSpan.text,
  );
  assert.equal(newerMessages.primitiveParameters.quantity, null);
  const newerMarkup = primitives.semanticSentencePrimitiveMarkup(
    newerMessages,
    sentences.indexOf(newerMessages),
  );
  assert.doesNotMatch(newerMarkup, />1999<|>2019<|>2038</);
  assert.doesNotMatch(newerMarkup, />CURRENT</);
  assert.match(newerMarkup, /data-comparison-concept="capacity"/);
  assert.match(newerMarkup, />WEEK COUNTER</);
  assert.match(newerMarkup, />NEWER MESSAGE</);
  assert.match(newerMarkup, />MORE ROOM</);
  assert.match(newerMarkup, /while newer navigation[\s\S]*messages give/);

  const limitedValues = sentences.find(
    (sentence) => sentence.wordSpan.text.includes("limited set"),
  );
  assert.ok(limitedValues);
  const limitedValuesMarkup = primitives.semanticSentencePrimitiveMarkup(
    limitedValues,
    sentences.indexOf(limitedValues),
  );
  assert.match(
    limitedValuesMarkup,
    /data-finite-counter-concept="bounded_range"/,
  );
  assert.match(limitedValuesMarkup, />FINITE VALUE SPACE</);
  assert.doesNotMatch(limitedValuesMarkup, /class="counter-cycle"/);

  const tenBits = sentences.find(
    (sentence) => sentence.wordSpan.text.includes("ten bits"),
  );
  assert.ok(tenBits);
  assert.equal(tenBits.primitiveParameters.quantity.value, "ten");
  assert.equal(tenBits.primitiveParameters.quantity.unit, "bits");
  const tenBitMarkup = primitives.semanticSentencePrimitiveMarkup(
    tenBits,
    sentences.indexOf(tenBits),
  );
  assert.equal(
    (tenBitMarkup.match(/data-bit-index=/g) || []).length,
    10,
  );
  assert.match(tenBitMarkup, /data-cause-concept="bit_register"/);
  assert.match(tenBitMarkup, /data-simple-visible-step-count="1"/);
  assert.doesNotMatch(tenBitMarkup, />SIGNAL</);
  assert.match(tenBitMarkup, />TEN BITS</);
  assert.doesNotMatch(tenBitMarkup, /class="counter-cycle"/);

  const wrongDate = sentences.find(
    (sentence) => sentence.wordSpan.text.includes("wrong date"),
  );
  assert.ok(wrongDate);
  assert.equal(wrongDate.capability.assetId, "receiver_device");
  const wrongDateMarkup = primitives.semanticSentencePrimitiveMarkup(
    wrongDate,
    sentences.indexOf(wrongDate),
  );
  assert.match(wrongDateMarkup, /data-cause-concept="wrong_date"/);
  assert.match(wrongDateMarkup, /data-simple-visible-step-count="2"/);
  assert.match(wrongDateMarkup, />GPS VALUE</);
  assert.doesNotMatch(wrongDateMarkup, />INTERPRET</);
  assert.match(wrongDateMarkup, />WRONG DATE</);

  const hauntedClock = sentences.find(
    (sentence) => sentence.wordSpan.text.includes("clocks looked haunted"),
  );
  assert.ok(hauntedClock);
  const hauntedClockMarkup = primitives.semanticSentencePrimitiveMarkup(
    hauntedClock,
    sentences.indexOf(hauntedClock),
  );
  assert.equal(
    hauntedClock.primitiveParameters.visualConceptId,
    "cue_evidence_focus",
  );
  assert.doesNotMatch(
    hauntedClockMarkup,
    /data-cause-concept="wrong_date"|>GPS VALUE<|>CLOCK ANOMALY</,
  );
  assert.match(hauntedClockMarkup, /data-evidence-variant="focus"/);
  assert.match(hauntedClockMarkup, /clocks looked haunted/i);
  assert.doesNotMatch(
    hauntedClockMarkup,
    />WRONG DATE|>DATE ERROR|>TIME ERROR/,
  );

  const softwarePatch = sentences.find(
    (sentence) => sentence.wordSpan.text.includes("software patches"),
  );
  assert.ok(softwarePatch);
  const softwarePatchMarkup = primitives.semanticSentencePrimitiveMarkup(
    softwarePatch,
    sentences.indexOf(softwarePatch),
  );
  assert.match(softwarePatchMarkup, /data-cause-concept="software_patch"/);
  assert.match(softwarePatchMarkup, /data-simple-visible-step-count="2"/);
  assert.match(softwarePatchMarkup, />AMBIGUITY</);
  assert.match(softwarePatchMarkup, />SOFTWARE PATCH</);
  assert.doesNotMatch(softwarePatchMarkup, />UPDATE REQUIRED</);

  const ordinaryMechanism = sentences.find(
    (sentence) => sentence.wordSpan.text.includes("mechanism was ordinary"),
  );
  assert.ok(ordinaryMechanism);
  const ordinaryMechanismMarkup = primitives.semanticSentencePrimitiveMarkup(
    ordinaryMechanism,
    sentences.indexOf(ordinaryMechanism),
  );
  assert.doesNotMatch(
    ordinaryMechanismMarkup,
    /data-cause-concept="counter_mapping_mechanism"/,
  );
  assert.doesNotMatch(
    ordinaryMechanismMarkup,
    />COUNTER VALUE|>RECEIVER RULE|>DISPLAY VALUE|>LAST→0/,
  );
  assert.match(ordinaryMechanismMarkup, />… WAS ORDINARY\.</);

  const explicitMapping = compileRaw(
    readGpsWithExplicitCounterMechanism(),
    "explicit-counter-mapping-regression",
    "prj_explicit_counter_mapping_regression",
  );
  const explicitMappingSentences = explicitMapping.compiled.animationIR.content
    .semanticVisualSentencePlan.sentences;
  const explicitMappingSentence = explicitMappingSentences.find(
    (sentence) => sentence.wordSpan.text.includes("counter mapping mechanism"),
  );
  assert.ok(explicitMappingSentence);
  assert.equal(
    explicitMappingSentence.primitiveParameters.visualConceptId,
    "counter_mapping_mechanism",
  );
  const explicitMappingMarkup = primitives.semanticSentencePrimitiveMarkup(
    explicitMappingSentence,
    explicitMappingSentences.indexOf(explicitMappingSentence),
  );
  assert.match(
    explicitMappingMarkup,
    /data-cause-concept="counter_mapping_mechanism"/,
  );
  assert.match(explicitMappingMarkup, />COUNTER</);
  assert.match(explicitMappingMarkup, />VALUE</);
  assert.match(explicitMappingMarkup, />MAPPING RULE</);
  assert.match(explicitMappingMarkup, />RESULT</);
  assert.match(
    explicitMappingMarkup,
    /counter mapping[\s\S]*mechanism was ordinary/,
  );
  assert.doesNotMatch(
    explicitMappingMarkup,
    />LAST→0|>RECEIVER RULE|>ORDINARY MAPPING/,
  );

  const notTime = sentences.find(
    (sentence) => sentence.wordSpan.text.includes("not time itself"),
  );
  assert.ok(notTime);
  const notTimeMarkup = primitives.semanticSentencePrimitiveMarkup(
    notTime,
    sentences.indexOf(notTime),
  );
  assert.equal(
    notTime.primitiveParameters.visualConceptId,
    "hypothesis_rejection",
  );
  assert.doesNotMatch(
    notTimeMarkup,
    /data-comparison-concept="counter_vs_time"|>NUMBER RESETS|>TIME CONTINUES/,
  );
  assert.match(notTimeMarkup, />NOT TIME ITSELF\.</);
  assert.match(
    notTimeMarkup,
    /class="semantic-bounded-geometry"[\s\S]*opacity="\.025"[\s\S]*data-visual-role="supporting_scaffold"/,
  );

  const explicitNotTime = compileRaw(
    readGpsWithExplicitCounterNotTime(),
    "explicit-counter-not-time-regression",
    "prj_explicit_counter_not_time_regression",
  );
  const explicitNotTimeSentences = explicitNotTime.compiled.animationIR.content
    .semanticVisualSentencePlan.sentences;
  const explicitNotTimeSentence = explicitNotTimeSentences.find(
    (sentence) => (
      sentence.primitiveParameters.visualConceptId === "counter_not_time"
    ),
  );
  assert.ok(explicitNotTimeSentence);
  const explicitNotTimeMarkup = primitives.semanticSentencePrimitiveMarkup(
    explicitNotTimeSentence,
    explicitNotTimeSentences.indexOf(explicitNotTimeSentence),
  );
  assert.match(
    explicitNotTimeMarkup,
    /data-comparison-concept="counter_vs_time"/,
  );
  assert.match(explicitNotTimeMarkup, />NUMBER RESETS</);
  assert.match(explicitNotTimeMarkup, />TIME CONTINUES</);
  assert.match(explicitNotTimeMarkup, /data-simple-visible-step-count="2"/);
  assert.doesNotMatch(explicitNotTimeMarkup, />NOT TIME ITSELF</);

  const twentyFourBitRaw = readRaw("002_gps_week_rollover");
  twentyFourBitRaw.script.beats[1].spokenText =
    twentyFourBitRaw.script.beats[1].spokenText
      .replace("ten bits", "twenty four bits");
  const twentyFourBits = compileRaw(
    twentyFourBitRaw,
    "multiword-bit-geometry-regression",
    "prj_multiword_bit_geometry_regression",
  );
  const twentyFourBitSentence = twentyFourBits.compiled.animationIR.content
    .semanticVisualSentencePlan.sentences.find(
      (sentence) => sentence.wordSpan.text.includes("twenty four bits"),
    );
  assert.ok(twentyFourBitSentence);
  const twentyFourBitMarkup = primitives.semanticSentencePrimitiveMarkup(
    twentyFourBitSentence,
    twentyFourBits.compiled.animationIR.content.semanticVisualSentencePlan
      .sentences.indexOf(twentyFourBitSentence),
  );
  assert.equal(
    (twentyFourBitMarkup.match(/data-bit-index=/g) || []).length,
    24,
  );
  assert.doesNotMatch(
    twentyFourBitMarkup,
    /class="semantic-rise" data-bit-index=/,
  );
  const bitCells = [...twentyFourBitMarkup.matchAll(
    /data-bit-index="(\d+)">\s*<rect x="([0-9.]+)" y="([0-9.]+)" width="([0-9.]+)" height="([0-9.]+)"/g,
  )].map((match) => ({
    index: Number(match[1]),
    x: Number(match[2]),
    y: Number(match[3]),
    width: Number(match[4]),
    height: Number(match[5]),
  }));
  assert.equal(bitCells.length, 24);
  for (const cell of bitCells) {
    assert.ok(cell.x >= 164, `bit ${cell.index} starts inside its panel`);
    assert.ok(
      cell.x + cell.width <= 556,
      `bit ${cell.index} ends inside its panel`,
    );
    assert.ok(cell.y >= 354, `bit ${cell.index} starts below panel top`);
    assert.ok(
      cell.y + cell.height <= 520,
      `bit ${cell.index} clears the quantity label`,
    );
  }

  const thirtyTwoBitRaw = readRaw("002_gps_week_rollover");
  thirtyTwoBitRaw.script.beats[1].spokenText =
    thirtyTwoBitRaw.script.beats[1].spokenText
      .replace("ten bits", "thirty two bits");
  const thirtyTwoBits = compileRaw(
    thirtyTwoBitRaw,
    "thirty-two-bit-exact-geometry-regression",
    "prj_thirty_two_bit_exact_geometry_regression",
  );
  const thirtyTwoBitPlan = thirtyTwoBits.compiled.animationIR.content
    .semanticVisualSentencePlan;
  const thirtyTwoBitSentence = thirtyTwoBitPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("thirty two bits"),
  );
  assert.ok(thirtyTwoBitSentence);
  const thirtyTwoBitMarkup = primitives.semanticSentencePrimitiveMarkup(
    thirtyTwoBitSentence,
    thirtyTwoBitPlan.sentences.indexOf(thirtyTwoBitSentence),
  );
  assert.equal(
    (thirtyTwoBitMarkup.match(/data-bit-index=/g) || []).length,
    32,
  );
  assert.match(thirtyTwoBitMarkup, /data-bit-render-mode="exact"/);
  assert.match(thirtyTwoBitMarkup, /data-declared-bit-count="32"/);
  assert.match(thirtyTwoBitMarkup, />THIRTY TWO BITS</);
  assert.doesNotMatch(
    thirtyTwoBitMarkup,
    /class="micro-copy">[01]<\/text>/,
  );

  const hyphenatedBitRaw = readRaw("002_gps_week_rollover");
  hyphenatedBitRaw.script.beats[1].spokenText =
    hyphenatedBitRaw.script.beats[1].spokenText
      .replace("ten bits", "a 32-bit field");
  const hyphenatedBits = compileRaw(
    hyphenatedBitRaw,
    "hyphenated-bit-exact-geometry-regression",
    "prj_hyphenated_bit_exact_geometry_regression",
  );
  const hyphenatedBitPlan = hyphenatedBits.compiled.animationIR.content
    .semanticVisualSentencePlan;
  const hyphenatedBitSentence = hyphenatedBitPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("32-bit field"),
  );
  assert.ok(hyphenatedBitSentence);
  assert.equal(hyphenatedBitSentence.primitiveParameters.quantity.value, "32");
  assert.equal(hyphenatedBitSentence.primitiveParameters.quantity.unit, "bit");
  const hyphenatedBitMarkup = primitives.semanticSentencePrimitiveMarkup(
    hyphenatedBitSentence,
    hyphenatedBitPlan.sentences.indexOf(hyphenatedBitSentence),
  );
  assert.equal(
    (hyphenatedBitMarkup.match(/data-bit-index=/g) || []).length,
    32,
  );
  assert.match(hyphenatedBitMarkup, /data-bit-render-mode="exact"/);
  assert.match(hyphenatedBitMarkup, /data-declared-bit-count="32"/);
  assert.match(hyphenatedBitMarkup, />32 BIT</);

  const hundredBitRaw = readRaw("002_gps_week_rollover");
  hundredBitRaw.script.beats[1].spokenText =
    hundredBitRaw.script.beats[1].spokenText
      .replace("ten bits", "one hundred bits");
  const hundredBits = compileRaw(
    hundredBitRaw,
    "hundred-bit-symbolic-geometry-regression",
    "prj_hundred_bit_symbolic_geometry_regression",
  );
  const hundredBitPlan = hundredBits.compiled.animationIR.content
    .semanticVisualSentencePlan;
  const hundredBitSentence = hundredBitPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("one hundred bits"),
  );
  assert.ok(hundredBitSentence);
  const hundredBitMarkup = primitives.semanticSentencePrimitiveMarkup(
    hundredBitSentence,
    hundredBitPlan.sentences.indexOf(hundredBitSentence),
  );
  assert.match(
    hundredBitMarkup,
    /data-bit-render-mode="symbolic_summary"/,
  );
  assert.match(hundredBitMarkup, /data-declared-bit-count="100"/);
  assert.match(hundredBitMarkup, />SYMBOLIC SAMPLE</);
  assert.match(hundredBitMarkup, />ONE HUNDRED BITS</);

  const unspecifiedBitsRaw = readRaw("002_gps_week_rollover");
  unspecifiedBitsRaw.script.beats[1].spokenText =
    unspecifiedBitsRaw.script.beats[1].spokenText
      .replace("in ten bits", "as bits");
  const unspecifiedBits = compileRaw(
    unspecifiedBitsRaw,
    "unspecified-bit-count-symbolic-geometry",
    "prj_unspecified_bit_count_symbolic_geometry",
  );
  const unspecifiedBitPlan = unspecifiedBits.compiled.animationIR.content
    .semanticVisualSentencePlan;
  const unspecifiedBitSentence = unspecifiedBitPlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("week number as bits"),
  );
  assert.ok(unspecifiedBitSentence);
  assert.equal(
    unspecifiedBitSentence.primitiveParameters.visualConceptId,
    "encoded_bit_register",
  );
  assert.equal(unspecifiedBitSentence.primitiveParameters.quantity, null);
  const unspecifiedBitMarkup = primitives.semanticSentencePrimitiveMarkup(
    unspecifiedBitSentence,
    unspecifiedBitPlan.sentences.indexOf(unspecifiedBitSentence),
  );
  assert.match(
    unspecifiedBitMarkup,
    /data-bit-render-mode="symbolic_summary"/,
  );
  assert.match(
    unspecifiedBitMarkup,
    /data-declared-bit-count="unspecified"/,
  );
  assert.match(unspecifiedBitMarkup, />SYMBOLIC SAMPLE</);
  assert.doesNotMatch(unspecifiedBitMarkup, />TEN BITS|data-bit-index="16"/);

  const cadenceRaw = readRaw("002_gps_week_rollover");
  cadenceRaw.script.beats[0].spokenText =
    "Every one hundred weeks. The legacy GPS week counter resets to zero. Some devices that handled it incorrectly showed the wrong date.";
  const cadence = compileRaw(
    cadenceRaw,
    "recurrence-cadence-is-not-reset-target",
    "prj_recurrence_cadence_is_not_reset_target",
  );
  const cadencePlan = cadence.compiled.animationIR.content
    .semanticVisualSentencePlan;
  const cadenceSentence = cadencePlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("one hundred weeks"),
  );
  assert.ok(cadenceSentence);
  assert.equal(cadenceSentence.primitiveParameters.quantity.value, "zero");
  assert.equal(cadenceSentence.primitiveParameters.quantity.unit, null);
  assert.equal(
    cadenceSentence.primitiveParameters.visualConceptId,
    "finite_counter_wrap",
  );
  const cadenceMarkup = primitives.semanticSentencePrimitiveMarkup(
    cadenceSentence,
    cadencePlan.sentences.indexOf(cadenceSentence),
  );
  assert.match(cadenceMarkup, />RESET TO</);
  assert.match(cadenceMarkup, />ZERO</);
  assert.doesNotMatch(cadenceMarkup, />ONE HUNDRED WEEKS</);

  const pureCadenceRaw = readRaw("002_gps_week_rollover");
  pureCadenceRaw.script.beats[0].spokenText =
    "Every one hundred weeks, engineers record a sample for comparison.";
  const pureCadence = compileRaw(
    pureCadenceRaw,
    "pure-cadence-duration-regression",
    "prj_pure_cadence_duration_regression",
  );
  const pureCadencePlan = pureCadence.compiled.animationIR.content
    .semanticVisualSentencePlan;
  const pureCadenceSentence = pureCadencePlan.sentences.find(
    (sentence) => sentence.wordSpan.text.includes("one hundred weeks"),
  );
  assert.ok(pureCadenceSentence);
  assert.equal(
    pureCadenceSentence.primitiveParameters.visualConceptId,
    "duration_timeline",
  );
  assert.equal(
    pureCadenceSentence.primitiveParameters.quantity.value,
    "one hundred",
  );
  assert.equal(pureCadenceSentence.primitiveParameters.quantity.unit, "weeks");

  const hoursRaw = readRaw("002_gps_week_rollover");
  hoursRaw.script.beats[1].spokenText = hoursRaw.script.beats[1].spokenText
    .replace("ten bits", "twenty four hours");
  const hours = compileRaw(
    hoursRaw,
    "multiword-unit-render-regression",
    "prj_multiword_unit_render_regression",
  );
  const hourSentence = hours.compiled.animationIR.content
    .semanticVisualSentencePlan.sentences.find(
      (sentence) => sentence.wordSpan.text.includes("twenty four hours"),
    );
  assert.ok(hourSentence);
  assert.equal(hourSentence.primitiveParameters.quantity.value, "twenty four");
  assert.equal(hourSentence.primitiveParameters.quantity.unit, "hours");
  assert.match(
    primitives.semanticSentencePrimitiveMarkup(
      hourSentence,
      hours.compiled.animationIR.content.semanticVisualSentencePlan
        .sentences.indexOf(hourSentence),
    ),
    /TWENTY FOUR HOURS/,
  );

  const longQuantityRaw = readRaw("002_gps_week_rollover");
  longQuantityRaw.script.beats[1].spokenText =
    longQuantityRaw.script.beats[1].spokenText
      .replace("ten bits", "one hundred and twenty years");
  const longQuantity = compileRaw(
    longQuantityRaw,
    "long-quantity-render-regression",
    "prj_long_quantity_render_regression",
  );
  const longQuantitySentence = longQuantity.compiled.animationIR.content
    .semanticVisualSentencePlan.sentences.find(
      (sentence) => sentence.wordSpan.text.includes(
        "one hundred and twenty years",
      ),
    );
  assert.ok(longQuantitySentence);
  const longQuantityMarkup = primitives.semanticSentencePrimitiveMarkup(
    longQuantitySentence,
    longQuantity.compiled.animationIR.content.semanticVisualSentencePlan
      .sentences.indexOf(longQuantitySentence),
  );
  assert.match(longQuantityMarkup, /ONE HUNDRED AND TWENTY YEARS/);
  assert.doesNotMatch(longQuantityMarkup, /ONE … YEARS/);

  for (const [needle, expected] of [
    ["leaving", /FINITE VALUE SPACE/],
    ["equipment", /SOFTWARE PATCH/],
  ]) {
    const sentence = sentences.find(
      (candidate) => candidate.wordSpan.text.toLowerCase().includes(needle),
    );
    assert.ok(sentence, needle);
    const markup = primitives.semanticSentencePrimitiveMarkup(
      sentence,
      sentences.indexOf(sentence),
    );
    assert.match(markup, expected, needle);
    assert.doesNotMatch(
      markup,
      />(?:LEAVING|EQUIPMENT)</,
      needle,
    );
  }

  const wow = compileRaw(
    readRaw("001_wow_signal_mystery"),
    "quantity-priority-regression",
    "prj_quantity_priority_regression",
  );
  const wowSentences = wow.compiled.animationIR.content
    .semanticVisualSentencePlan.sentences;
  const yearSentence = wowSentences.find(
    (sentence) => sentence.wordSpan.text.includes("1977"),
  );
  assert.ok(yearSentence);
  assert.equal(yearSentence.primitiveParameters.quantity.value, "1977");
  assert.match(
    primitives.semanticSentencePrimitiveMarkup(
      yearSentence,
      wowSentences.indexOf(yearSentence),
    ),
    />1977</,
  );
  const incidentalOne = wowSentences.find(
    (sentence) => sentence.wordSpan.text.includes("one strong unexplained"),
  );
  assert.ok(incidentalOne);
  assert.equal(incidentalOne.primitiveParameters.quantity, null);
  const affirmedCauseRaw = readRaw("001_wow_signal_mystery");
  affirmedCauseRaw.script.beats[2].spokenText =
    "Heavy rain caused a launch delay.";
  const affirmedCausePlan = compileRaw(
    affirmedCauseRaw,
    "affirmed-cause-render-regression",
    "prj_affirmed_cause_render_regression",
  ).compiled.animationIR.content.semanticVisualSentencePlan;
  const affirmedCause = affirmedCausePlan.sentences.find((sentence) => (
    sentence.capability.grammarId === "cause_effect_chain"
    && sentence.primitiveParameters.stateToken === "RESULT"
  ));
  assert.ok(affirmedCause);
  const affirmedCauseMarkup = primitives.semanticSentencePrimitiveMarkup(
    affirmedCause,
    affirmedCausePlan.sentences.indexOf(affirmedCause),
  );
  assert.match(affirmedCauseMarkup, /data-cause-result="affirmed"/);
  assert.doesNotMatch(affirmedCauseMarkup, /class="semantic-draw error-cross"/);

  const reversedRoute = structuredClone(
    compileRaw(
      readBaychimoWithGroundedRoute(),
      "route-order-regression",
      "prj_route_order_regression",
    ).compiled.animationIR.content.semanticVisualSentencePlan.sentences.find(
      (sentence) => sentence.primitiveParameters?.geometry.route,
    ).primitiveParameters,
  );
  reversedRoute.geometry.direction = "reverse";
  assertFailure(
    () => normalizeSemanticPrimitiveParameters(reversedRoute),
    "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
    "approved_route_order_must_be_preserved",
  );

  const general = compileRaw(
    readRaw("004_general_word_collision"),
    "negation-display-regression",
    "prj_negation_display_regression",
  );
  const causation = general.compiled.animationIR.content
    .semanticVisualSentencePlan.sentences.find(
      (sentence) => sentence.wordSpan.text.toLowerCase().includes("causation"),
    );
  assert.ok(causation);
  const causationMarkup = primitives.semanticSentencePrimitiveMarkup(
    causation,
    general.compiled.animationIR.content.semanticVisualSentencePlan
      .sentences.indexOf(causation),
  );
  assert.match(causationMarkup, /NOT CAUSATION/);

  const baychimo = compileRaw(
    readBaychimoWithGroundedRoute(),
    "intact-label-regression",
    "prj_intact_label_regression",
  );
  const reappearance = baychimo.compiled.animationIR.content
    .semanticVisualSentencePlan.sentences.find(
      (sentence) => sentence.primitiveParameters.subject.value
        .toLowerCase().includes("reappeared"),
    );
  assert.ok(reappearance);
  const reappearanceMarkup = primitives.semanticSentencePrimitiveMarkup(
    reappearance,
    baychimo.compiled.animationIR.content.semanticVisualSentencePlan
      .sentences.indexOf(reappearance),
  );
  assert.match(reappearanceMarkup, /SHIP[\s\S]*REAPPEARED/);
  assert.doesNotMatch(reappearanceMarkup, />[A-Z] … REAPPEARED</);

  const disappearance = baychimo.compiled.animationIR.content
    .semanticVisualSentencePlan.sentences.find(
      (sentence) => sentence.capability.grammarId === "negative_space_absence",
    );
  assert.ok(disappearance);
  const disappearanceMarkup = primitives.semanticSentencePrimitiveMarkup(
    disappearance,
    baychimo.compiled.animationIR.content.semanticVisualSentencePlan
      .sentences.indexOf(disappearance),
  );
  assert.match(disappearanceMarkup, /data-absence-environment="ice_blizzard"/);
  assert.match(disappearanceMarkup, /class="ice-field"/);
  assert.match(disappearanceMarkup, /class="semantic-blizzard"/);
});

test("primitive parameter contracts escape grounded XML and fail closed on tampering", async () => {
  const primitives = await import(
    "../renderer/hyperframes/primitives/semantic-sentence-primitives.mjs"
  );
  const { compileAnimationIRToHtml } = await import(
    "../renderer/hyperframes/animation-ir-adapter.mjs"
  );
  const wow = compileRaw(
    readRaw("001_wow_signal_mystery"),
    "primitive-adversarial",
    "prj_primitive_adversarial",
  );
  const graph = wow.compiled.animationIR.content.semanticEventGraph;
  const plan = wow.compiled.animationIR.content.semanticVisualSentencePlan;
  const changedState = structuredClone(plan);
  delete changedState.contentHash;
  changedState.sentences[0].primitiveParameters.stateToken = "OBSERVED";
  const reboundPlan = normalizeSemanticVisualSentencePlan(changedState);
  assert.equal(
    reboundPlan.contentHash,
    semanticVisualSentencePlanContentHash(reboundPlan),
  );
  assertFailure(
    () => validateSemanticVisualSentencePlanAgainstGraph(reboundPlan, graph),
    "ANIMATION_SEMANTIC_VISUAL_SENTENCE_INVALID",
    "semantic_event_graph_binding_mismatch",
  );
  const reboundIR = structuredClone(wow.compiled.animationIR);
  reboundIR.content.semanticVisualSentencePlan = structuredClone(reboundPlan);
  reboundIR.content.semantic.semanticVisualSentencePlanHash =
    reboundPlan.contentHash;
  assert.throws(
    () => compileAnimationIRToHtml(reboundIR, rendererSourceOptions(wow)),
    /not bound to the embedded graph/,
  );

  const extraField = structuredClone(plan.sentences[0].primitiveParameters);
  extraField.svg = "<path/>";
  assertFailure(
    () => normalizeSemanticPrimitiveParameters(extraField),
    "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
    "unsupported_or_missing_field",
  );

  const inheritedLookupId = structuredClone(
    plan.sentences[0].primitiveParameters,
  );
  inheritedLookupId.visualConceptId = "constructor";
  assert.equal(
    normalizeSemanticPrimitiveParameters(inheritedLookupId).visualConceptId,
    "constructor",
  );

  const misleadingCompletedState = structuredClone(
    plan.sentences[0].primitiveParameters,
  );
  misleadingCompletedState.stateToken = "UPDATED";
  assertFailure(
    () => normalizeSemanticPrimitiveParameters(misleadingCompletedState),
    "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
    "unsupported_value",
  );

  const gpsBindings = compileRaw(
    readRaw("002_gps_week_rollover"),
    "visual-concept-binding-adversarial",
    "prj_visual_concept_binding_adversarial",
  );
  const gpsBindingPlan = gpsBindings.compiled.animationIR.content
    .semanticVisualSentencePlan;
  const neutralFocusSentence = gpsBindingPlan.sentences.find(
    (sentence) => (
      sentence.primitiveParameters.visualConceptId === "cue_evidence_focus"
      && sentence.wordSpan.text.includes("clocks looked haunted")
    ),
  );
  assert.ok(neutralFocusSentence);
  for (const unsupportedNeutralConcept of [
    "cue_evidence_document",
    "cue_evidence_network",
    "cue_evidence_quote",
  ]) {
    const unsupportedNeutral = structuredClone(
      neutralFocusSentence.primitiveParameters,
    );
    unsupportedNeutral.visualConceptId = unsupportedNeutralConcept;
    assertFailure(
      () => normalizeSemanticPrimitiveParameters(unsupportedNeutral),
      "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
      "concept_grounding_mismatch",
    );
  }
  const mappingBindings = compileRaw(
    readGpsWithExplicitCounterMechanism(),
    "visual-concept-mapping-binding-adversarial",
    "prj_visual_concept_mapping_binding_adversarial",
  );
  const mappingBindingSentence = mappingBindings.compiled.animationIR.content
    .semanticVisualSentencePlan.sentences.find(
      (sentence) => (
        sentence.primitiveParameters.visualConceptId
          === "counter_mapping_mechanism"
      ),
  );
  assert.ok(mappingBindingSentence);
  const neutralWithSpecializedBinding = structuredClone(
    mappingBindingSentence.primitiveParameters,
  );
  neutralWithSpecializedBinding.visualConceptId = "cue_evidence_focus";
  assertFailure(
    () => normalizeSemanticPrimitiveParameters(neutralWithSpecializedBinding),
    "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
    "concept_binding_mismatch",
  );
  const counterNotTimeBindings = compileRaw(
    readGpsWithExplicitCounterNotTime(),
    "visual-concept-counter-not-time-binding-adversarial",
    "prj_visual_concept_counter_not_time_binding_adversarial",
  );
  const counterNotTimeBindingSentence = counterNotTimeBindings.compiled
    .animationIR.content.semanticVisualSentencePlan.sentences.find(
      (sentence) => (
        sentence.primitiveParameters.visualConceptId === "counter_not_time"
      ),
    );
  assert.ok(counterNotTimeBindingSentence);
  const sourceSentenceForConcept = (visualConceptId) => (
    visualConceptId === "counter_mapping_mechanism"
      ? mappingBindingSentence
      : visualConceptId === "counter_not_time"
        ? counterNotTimeBindingSentence
      : gpsBindingPlan.sentences.find(
        (sentence) => (
          sentence.primitiveParameters.visualConceptId === visualConceptId
        ),
      )
  );
  const patchSentence = gpsBindingPlan.sentences.find(
    (sentence) => (
      sentence.primitiveParameters.visualConceptId
        === "receiver_patch_required"
    ),
  );
  assert.ok(patchSentence);
  const mismatchedPatchAsset = structuredClone(
    patchSentence.primitiveParameters,
  );
  mismatchedPatchAsset.assetId = "mapping_table";
  assertFailure(
    () => normalizeSemanticPrimitiveParameters(mismatchedPatchAsset),
    "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
    "concept_binding_mismatch",
  );
  const mismatchedPatchSentence = structuredClone(patchSentence);
  mismatchedPatchSentence.capability.assetId = "mapping_table";
  mismatchedPatchSentence.primitiveParameters.assetId = "mapping_table";
  assert.throws(
    () => primitives.semanticSentencePrimitiveMarkup(
      mismatchedPatchSentence,
      0,
    ),
    /Semantic primitive parameters are invalid/,
  );

  const changedPatchState = structuredClone(
    patchSentence.primitiveParameters,
  );
  changedPatchState.stateToken = "CHANGED";
  assertFailure(
    () => normalizeSemanticPrimitiveParameters(changedPatchState),
    "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
    "concept_binding_mismatch",
  );

  const replaceGroundedDetail = (parameters, value) => {
    parameters.detail.value = value;
    parameters.detail.sourceRef.value = value;
    parameters.detail.sourceRef.endOffset =
      parameters.detail.sourceRef.startOffset + value.length;
  };
  const ungroundedPatch = structuredClone(
    patchSentence.primitiveParameters,
  );
  replaceGroundedDetail(
    ungroundedPatch,
    "The receivers received software updates to reduce battery drain.",
  );
  assertFailure(
    () => normalizeSemanticPrimitiveParameters(ungroundedPatch),
    "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
    "concept_grounding_mismatch",
  );

  const bitSentence = gpsBindingPlan.sentences.find(
    (sentence) => (
      sentence.primitiveParameters.visualConceptId === "encoded_bit_register"
    ),
  );
  assert.ok(bitSentence);
  const ungroundedBitRegister = structuredClone(
    bitSentence.primitiveParameters,
  );
  ungroundedBitRegister.quantity = null;
  replaceGroundedDetail(
    ungroundedBitRegister,
    "The receiver encoded its identifier in a field for compatibility.",
  );
  assertFailure(
    () => normalizeSemanticPrimitiveParameters(ungroundedBitRegister),
    "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
    "concept_grounding_mismatch",
  );

  const forgedBitQuantity = structuredClone(
    bitSentence.primitiveParameters,
  );
  forgedBitQuantity.quantity.value = "64";
  forgedBitQuantity.quantity.valueSourceRef.value = "64";
  forgedBitQuantity.quantity.valueSourceRef.endOffset =
    forgedBitQuantity.quantity.valueSourceRef.startOffset + 2;
  assertFailure(
    () => normalizeSemanticPrimitiveParameters(forgedBitQuantity),
    "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
    "concept_grounding_mismatch",
  );

  const resetSentence = gpsBindingPlan.sentences.find(
    (sentence) => (
      sentence.primitiveParameters.visualConceptId === "finite_counter_wrap"
      && sentence.primitiveParameters.quantity?.value === "zero"
    ),
  );
  assert.ok(resetSentence);
  const forgedResetQuantity = structuredClone(
    resetSentence.primitiveParameters,
  );
  forgedResetQuantity.quantity.value = "999";
  forgedResetQuantity.quantity.valueSourceRef.value = "999";
  forgedResetQuantity.quantity.valueSourceRef.endOffset =
    forgedResetQuantity.quantity.valueSourceRef.startOffset + 3;
  assertFailure(
    () => normalizeSemanticPrimitiveParameters(forgedResetQuantity),
    "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
    "concept_grounding_mismatch",
  );

  const staleParameterProfile = structuredClone(
    bitSentence.primitiveParameters,
  );
  staleParameterProfile.schemaVersion = 1;
  staleParameterProfile.profileId =
    "dark_curiosity_story_primitive_parameters_v1";
  assertFailure(
    () => normalizeSemanticPrimitiveParameters(staleParameterProfile),
    "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
    "unsupported_schema",
  );

  const ungroundedSpecializedConcepts = [
    [
      "finite_counter_wrap",
      "The GPS receiver repeated its self-test every week.",
    ],
    [
      "bounded_value_range",
      "The GPS signal has limited indoor coverage near concrete walls.",
    ],
    ["bounded_value_range", "The receiver battery has a finite life."],
    ["bounded_value_range", "The receiver battery has finite capacity."],
    ["bounded_value_range", "The fixed set piece remained on the stage."],
    ["bounded_value_range", "The limited field of ruins remained unexplored."],
    [
      "counter_capacity_comparison",
      "Newer receivers are more reliable than legacy receivers.",
    ],
    [
      "counter_capacity_comparison",
      "The week counter sat beside a cabinet with more room.",
    ],
    [
      "counter_capacity_comparison",
      "The editor needed more room near the week counter.",
    ],
    [
      "counter_capacity_comparison",
      "Removing the old week counter gives engineers more room in the receiver.",
    ],
    [
      "counter_mapping_mechanism",
      "GPS positions are calculated through satellite timing.",
    ],
    [
      "counter_mapping_mechanism",
      "The GPS antenna mechanism was ordinary.",
    ],
    [
      "counter_mapping_mechanism",
      "The editor mapped the week counter on the diagram.",
    ],
    [
      "counter_mapping_mechanism",
      "The GPS receiver watched as the editor mapped the counter to a chart.",
    ],
    [
      "bounded_value_range",
      "The manual listed possible values for screen brightness.",
    ],
    [
      "counter_not_time",
      "GPS receivers did not acquire the signal after startup.",
    ],
    ["encoded_bit_register", "The excavation field contained bits of glass."],
    ["encoded_bit_register", "The hardware store stores drill bits."],
    [
      "encoded_bit_register",
      "Her message contains bits of advice for the receiver.",
    ],
    [
      "encoded_bit_register",
      "The signal contains bits of static and noise.",
    ],
    [
      "encoded_bit_register",
      "The new message encoding works a bit better.",
    ],
    [
      "encoded_bit_register",
      "The new message encoding works a little bit better.",
    ],
    [
      "encoded_bit_register",
      "The message encoding uses bits and pieces from older drafts.",
    ],
    [
      "finite_counter_wrap",
      "The week counter stayed fixed when the rover rolled over.",
    ],
    [
      "counter_mapping_mechanism",
      "The week counter sat beside an ordinary antenna mechanism.",
    ],
    [
      "counter_not_time",
      "The editor's concern was not time itself, but the budget.",
    ],
    [
      "counter_date_misinterpretation",
      "The receiver sat beside a newspaper with the wrong date.",
    ],
    [
      "counter_date_misinterpretation",
      "The receiver reported that the newspaper had the wrong date.",
    ],
    [
      "receiver_patch_required",
      "The receiver manual mentioned counter ambiguity and needed software fixes for its typography.",
    ],
    [
      "receiver_patch_required",
      "The receiver required software fixes for a counter in the editor's article.",
    ],
    [
      "finite_counter_wrap",
      "The week counter sat beside a reset button.",
    ],
    [
      "bounded_value_range",
      "The week counter sat beside a cabinet with finite capacity.",
    ],
    [
      "encoded_bit_register",
      "The GPS receiver encoded a crate holding ten drill bits.",
    ],
    [
      "counter_date_misinterpretation",
      "The receiver watched as the newspaper showed the wrong date.",
    ],
    [
      "receiver_patch_required",
      "The receiver handled the ambiguity near its manual which needed software fixes for typography.",
    ],
    [
      "counter_capacity_comparison",
      "The GPS counter has more capacity than the clock.",
    ],
    [
      "counter_date_misinterpretation",
      "The receiver watched as the calendar showed the wrong date.",
    ],
    [
      "counter_mapping_mechanism",
      "The counter sat beside a mapping mechanism.",
    ],
    ["finite_counter_wrap", "The phone number reset itself."],
    [
      "bounded_value_range",
      "The counter has a finite capacity battery.",
    ],
    [
      "receiver_patch_required",
      "The receiver manual needed a software update for counter ambiguity.",
    ],
    [
      "finite_counter_wrap",
      "The GPS week counter reset the receiver display.",
    ],
    [
      "bounded_value_range",
      "The GPS week counter stores a battery with finite capacity.",
    ],
    [
      "counter_date_misinterpretation",
      "The GPS receiver stood beside a clock that showed the wrong time.",
    ],
    [
      "counter_date_misinterpretation",
      "The report listed the wrong date because the editor mistyped it.",
    ],
  ];
  for (const [visualConceptId, ungroundedDetail] of ungroundedSpecializedConcepts) {
    const sourceSentence = sourceSentenceForConcept(visualConceptId);
    assert.ok(sourceSentence, visualConceptId);
    const parameters = structuredClone(sourceSentence.primitiveParameters);
    parameters.quantity = null;
    replaceGroundedDetail(parameters, ungroundedDetail);
    assertFailure(
      () => normalizeSemanticPrimitiveParameters(parameters),
      "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
      "concept_grounding_mismatch",
    );
  }

  const negatedSpecializedConcepts = [
    ["finite_counter_wrap", "The counter did not roll over."],
    ["finite_counter_wrap", "The counter hasn't rolled over."],
    ["finite_counter_wrap", "The counter failed to roll over."],
    ["bounded_value_range", "The counter is not finite."],
    ["bounded_value_range", "The counter lacks a finite value space."],
    [
      "counter_capacity_comparison",
      "Newer messages do not give the week counter more room.",
    ],
    ["counter_mapping_mechanism", "The mechanism was not ordinary."],
    ["encoded_bit_register", "The signal does not store bits."],
    [
      "counter_date_misinterpretation",
      "The receiver did not show the wrong date.",
    ],
    [
      "receiver_patch_required",
      "The equipment had software patches that were not required for counter ambiguity.",
    ],
    [
      "receiver_patch_required",
      "Software patches won’t be required for counter ambiguity.",
    ],
    [
      "counter_capacity_comparison",
      "Neither newer navigation messages nor the week counter have more room.",
    ],
  ];
  for (const [visualConceptId, negatedDetail] of negatedSpecializedConcepts) {
    const sourceSentence = sourceSentenceForConcept(visualConceptId);
    assert.ok(sourceSentence, visualConceptId);
    const parameters = structuredClone(sourceSentence.primitiveParameters);
    parameters.quantity = null;
    replaceGroundedDetail(parameters, negatedDetail);
    assertFailure(
      () => normalizeSemanticPrimitiveParameters(parameters),
      "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
      "concept_grounding_mismatch",
    );
  }

  const temporalErrorSentence = gpsBindingPlan.sentences.find(
    (sentence) => (
      sentence.primitiveParameters.visualConceptId
        === "counter_date_misinterpretation"
    ),
  );
  assert.ok(temporalErrorSentence);
  const ungroundedTemporalError = structuredClone(
    temporalErrorSentence.primitiveParameters,
  );
  replaceGroundedDetail(
    ungroundedTemporalError,
    "The GPS receiver used the wrong antenna during the test.",
  );
  assertFailure(
    () => normalizeSemanticPrimitiveParameters(ungroundedTemporalError),
    "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
    "concept_grounding_mismatch",
  );
  const ungroundedTemporalSentence = structuredClone(temporalErrorSentence);
  ungroundedTemporalSentence.primitiveParameters = ungroundedTemporalError;
  assert.throws(
    () => primitives.semanticSentencePrimitiveMarkup(
      ungroundedTemporalSentence,
      0,
    ),
    /Semantic primitive parameters are invalid/,
  );

  const transitionMismatch = structuredClone(
    mappingBindings.compiled.animationIR.content.semanticEventGraph,
  );
  delete transitionMismatch.contentHash;
  const ordinaryMapping = transitionMismatch.propositions.find(
    (proposition) => (
      proposition.primitivePayload.visualConceptId
        === "counter_mapping_mechanism"
    ),
  );
  assert.ok(ordinaryMapping);
  ordinaryMapping.primitivePayload.visualConceptId =
    "receiver_patch_required";
  assertFailure(
    () => normalizeSemanticEventGraph(transitionMismatch),
    "ANIMATION_SEMANTIC_EVENT_INVALID",
    "concept_transition_mismatch",
  );

  const remote = structuredClone(plan.sentences[0].primitiveParameters);
  remote.subject.value = "https://unsafe.example";
  remote.subject.sourceRef.value = remote.subject.value;
  remote.subject.sourceRef.endOffset =
    remote.subject.sourceRef.startOffset + remote.subject.value.length;
  assertFailure(
    () => normalizeSemanticPrimitiveParameters(remote),
    "ANIMATION_SEMANTIC_PRIMITIVE_PARAMETERS_INVALID",
    "bounded_safe_text_required",
  );

  const escapedSentence = structuredClone(plan.sentences[0]);
  const escapedValue = "Archive A & B <copy>";
  escapedSentence.primitiveParameters.subject.value = escapedValue;
  escapedSentence.primitiveParameters.subject.sourceRef.value = escapedValue;
  escapedSentence.primitiveParameters.subject.sourceRef.endOffset =
    escapedSentence.primitiveParameters.subject.sourceRef.startOffset
      + escapedValue.length;
  rebindSyntheticGeometryBlueprint(escapedSentence);
  const escapedMarkup = primitives.semanticSentencePrimitiveMarkup(
    escapedSentence,
    0,
  );
  assert.match(escapedMarkup, /ARCHIVE A &amp;/);
  assert.match(escapedMarkup, /B &lt;COPY&gt;/);
  assert.doesNotMatch(escapedMarkup, /<copy>/i);

  const baychimo = compileRaw(
    readBaychimoWithGroundedRoute(),
    "primitive-route-adversarial",
    "prj_primitive_route_adversarial",
  );
  const reboundGraph = structuredClone(
    baychimo.compiled.animationIR.content.semanticEventGraph,
  );
  delete reboundGraph.contentHash;
  const routeProposition = reboundGraph.propositions.find(
    (proposition) => proposition.primitivePayload?.geometry,
  );
  routeProposition.primitivePayload.geometry.points[0][0] += 0.01;
  assertFailure(
    () => validateSemanticEventGraphAgainstDraft(reboundGraph, {
      draft: baychimo.draft,
      timingContext: baychimo.timingContext,
    }),
    "ANIMATION_SEMANTIC_EVENT_INVALID",
    "source_binding_mismatch",
  );
});

test("the checked profile registry remains a two-entry exact golden allowlist", () => {
  const profiles = listSemanticEventProfiles();
  assert.equal(profiles.length, 2);
  for (const profile of profiles) {
    const resolved = findSemanticEventProfile(profile);
    assert.ok(resolved);
    assert.equal(resolved.draftHash, profile.draftHash);
    assert.equal(resolved.alignmentHash, profile.alignmentHash);
  }
});

test("every parameterized grammar branch renders grounded markup", async () => {
  const primitives = await import(
    "../renderer/hyperframes/primitives/semantic-sentence-primitives.mjs"
  );
  const wow = compileRaw(
    readRaw("001_wow_signal_mystery"),
    "parameterized-grammar-matrix",
    "prj_parameterized_grammar_matrix",
  );
  const base = wow.compiled.animationIR.content
    .semanticVisualSentencePlan.sentences[0];
  assert.deepEqual(
    [...SEMANTIC_SENTENCE_RENDERER_GRAMMAR_IDS],
    [
      "before_after",
      "bounded_uncertainty",
      "cause_effect_chain",
      "chronology_accumulation",
      "evidence_inspection",
      "finite_cycle",
      "map_motion",
      "negative_space_absence",
      "side_by_side_comparison",
    ],
  );
  for (const grammarId of SEMANTIC_SENTENCE_RENDERER_GRAMMAR_IDS) {
    const sentence = structuredClone(base);
    const assetId =
      SEMANTIC_SENTENCE_RENDERER_GRAMMAR_ASSET_BINDINGS[grammarId][0];
    sentence.capability.grammarId = grammarId;
    sentence.capability.assetId = assetId;
    sentence.primitiveParameters.grammarId = grammarId;
    sentence.primitiveParameters.assetId = assetId;
    sentence.primitiveParameters.geometry.presetId =
      SEMANTIC_PRIMITIVE_PRESET_BY_GRAMMAR[grammarId];
    sentence.primitiveParameters.geometry.direction = "forward";
    sentence.primitiveParameters.geometry.route = null;
    rebindSyntheticGeometryBlueprint(sentence);
    const markup = primitives.semanticSentencePrimitiveMarkup(sentence, 0);
    assert.match(markup, /data-primitive-parameterized="true"/, grammarId);
    assert.match(markup, /data-geometry-kind="[^"]+"/, grammarId);
    assert.doesNotMatch(
      markup,
      />1023<|>0000<|>DATE<|>INPUT<|>OUTPUT</,
      grammarId,
    );
    if (grammarId === "negative_space_absence") {
      assert.match(markup, /data-absence-environment="neutral"/);
      assert.match(markup, /class="absence-neutral-field"/);
      assert.doesNotMatch(markup, /class="ice-field"|class="semantic-blizzard"/);
    }
  }

  const iceOnlyAbsence = structuredClone(base);
  iceOnlyAbsence.capability.grammarId = "negative_space_absence";
  iceOnlyAbsence.capability.assetId = "vessel";
  iceOnlyAbsence.primitiveParameters.grammarId = "negative_space_absence";
  iceOnlyAbsence.primitiveParameters.assetId = "vessel";
  iceOnlyAbsence.primitiveParameters.geometry.presetId =
    SEMANTIC_PRIMITIVE_PRESET_BY_GRAMMAR.negative_space_absence;
  iceOnlyAbsence.primitiveParameters.geometry.route = null;
  iceOnlyAbsence.primitiveParameters.quantity = null;
  const iceText = "The vessel vanished beside Arctic pack ice";
  iceOnlyAbsence.primitiveParameters.detail.value = iceText;
  iceOnlyAbsence.primitiveParameters.detail.sourceRef.value = iceText;
  iceOnlyAbsence.primitiveParameters.detail.sourceRef.endOffset =
    iceOnlyAbsence.primitiveParameters.detail.sourceRef.startOffset
      + iceText.length;
  rebindSyntheticSceneComposition(iceOnlyAbsence);
  const iceOnlyMarkup = primitives.semanticSentencePrimitiveMarkup(
    iceOnlyAbsence,
    0,
  );
  assert.match(iceOnlyMarkup, /data-absence-environment="ice"/);
  assert.match(iceOnlyMarkup, /class="ice-field"/);
  assert.doesNotMatch(iceOnlyMarkup, /class="semantic-blizzard"/);

  const longCause = structuredClone(base);
  longCause.capability.grammarId = "cause_effect_chain";
  longCause.capability.assetId = "mapping_table";
  longCause.primitiveParameters.grammarId = "cause_effect_chain";
  longCause.primitiveParameters.assetId = "mapping_table";
  longCause.primitiveParameters.geometry.presetId =
    SEMANTIC_PRIMITIVE_PRESET_BY_GRAMMAR.cause_effect_chain;
  longCause.primitiveParameters.geometry.route = null;
  longCause.primitiveParameters.quantity = null;
  const longWord = "Electromagnetically";
  longCause.primitiveParameters.detail.value = longWord;
  longCause.primitiveParameters.detail.sourceRef.value = longWord;
  longCause.primitiveParameters.detail.sourceRef.endOffset =
    longCause.primitiveParameters.detail.sourceRef.startOffset
      + longWord.length;
  rebindSyntheticSceneComposition(longCause);
  const longCauseMarkup = primitives.semanticSentencePrimitiveMarkup(
    longCause,
    0,
  );
  const causeLines = [...longCauseMarkup.matchAll(
    /data-cause-detail-line="\d+"[^>]*>([^<]+)<\/text>/g,
  )].map((match) => match[1]);
  assert.equal(causeLines.length, 2);
  assert.equal(causeLines.join(""), longWord.toUpperCase());
  assert.ok(causeLines.every((line) => Array.from(line).length <= 14));

  const longChronology = structuredClone(base);
  longChronology.capability.grammarId = "chronology_accumulation";
  longChronology.capability.assetId = "timeline_axis";
  longChronology.primitiveParameters.grammarId = "chronology_accumulation";
  longChronology.primitiveParameters.assetId = "timeline_axis";
  longChronology.primitiveParameters.geometry.presetId =
    SEMANTIC_PRIMITIVE_PRESET_BY_GRAMMAR.chronology_accumulation;
  longChronology.primitiveParameters.geometry.route = null;
  longChronology.primitiveParameters.quantity = null;
  const chronologyWord = "Counterchronology";
  for (const binding of [
    longChronology.primitiveParameters.subject,
    longChronology.primitiveParameters.detail,
  ]) {
    binding.value = chronologyWord;
    binding.sourceRef.value = chronologyWord;
    binding.sourceRef.endOffset = binding.sourceRef.startOffset
      + chronologyWord.length;
  }
  rebindSyntheticSceneComposition(longChronology);
  const longChronologyMarkup = primitives.semanticSentencePrimitiveMarkup(
    longChronology,
    0,
  );
  const chronologyLines = [...longChronologyMarkup.matchAll(
    /data-chronology-label-line="\d+"[^>]*>([^<]+)<\/text>/g,
  )].map((match) => match[1]);
  assert.ok(chronologyLines.length >= 4);
  assert.ok(chronologyLines.every((line) => Array.from(line).length <= 12));
  const causeAssetMarkups =
    SEMANTIC_SENTENCE_RENDERER_GRAMMAR_ASSET_BINDINGS
      .cause_effect_chain.map((assetId) => {
        const sentence = structuredClone(base);
        sentence.capability.grammarId = "cause_effect_chain";
        sentence.capability.assetId = assetId;
        sentence.primitiveParameters.grammarId = "cause_effect_chain";
        sentence.primitiveParameters.assetId = assetId;
        sentence.primitiveParameters.stateToken = "RESULT";
        sentence.primitiveParameters.geometry.presetId =
          SEMANTIC_PRIMITIVE_PRESET_BY_GRAMMAR.cause_effect_chain;
        sentence.primitiveParameters.geometry.direction = "forward";
        sentence.primitiveParameters.geometry.route = null;
        rebindSyntheticGeometryBlueprint(sentence);
        const markup = primitives.semanticSentencePrimitiveMarkup(sentence, 0);
        assert.match(markup, new RegExp(
          `data-cause-asset-motif="${assetId}"`,
        ));
        assert.match(markup, /data-cause-result="affirmed"/);
        assert.doesNotMatch(markup, /class="semantic-draw error-cross"/);
        return markup;
      });
  assert.equal(new Set(causeAssetMarkups).size, 4);
  const rejectedCause = structuredClone(base);
  rejectedCause.capability.grammarId = "cause_effect_chain";
  rejectedCause.capability.assetId = "mapping_table";
  rejectedCause.primitiveParameters.grammarId = "cause_effect_chain";
  rejectedCause.primitiveParameters.assetId = "mapping_table";
  rejectedCause.primitiveParameters.stateToken = "REJECTED";
  rejectedCause.primitiveParameters.geometry.presetId =
    SEMANTIC_PRIMITIVE_PRESET_BY_GRAMMAR.cause_effect_chain;
  rejectedCause.primitiveParameters.geometry.direction = "reverse";
  rejectedCause.primitiveParameters.geometry.route = null;
  rebindSyntheticGeometryBlueprint(rejectedCause);
  const rejectedMarkup = primitives.semanticSentencePrimitiveMarkup(
    rejectedCause,
    0,
  );
  assert.match(rejectedMarkup, /data-cause-result="rejected"/);
  assert.match(rejectedMarkup, /class="semantic-draw error-cross"/);
});

test("server-side generalized capability gates mirror the actual sentence renderer", async () => {
  const primitives = await import(
    "../renderer/hyperframes/primitives/semantic-sentence-primitives.mjs"
  );
  const renderer = await import(
    "../renderer/hyperframes/semantic-sentence-animation.mjs"
  );
  assert.deepEqual(
    [...SEMANTIC_SENTENCE_RENDERER_ASSET_IDS],
    [...primitives.SUPPORTED_SEMANTIC_SENTENCE_ASSETS],
  );
  assert.deepEqual(
    [...SEMANTIC_SENTENCE_RENDERER_GRAMMAR_IDS],
    [...primitives.SUPPORTED_SEMANTIC_SENTENCE_GRAMMARS],
  );
  assert.deepEqual(
    SEMANTIC_SENTENCE_RENDERER_GRAMMAR_ASSET_BINDINGS,
    renderer.SUPPORTED_SEMANTIC_SENTENCE_GRAMMAR_ASSET_BINDINGS,
  );
  assert.equal(
    primitives.SEMANTIC_PRIMITIVE_PARAMETER_PROFILE_ID,
    SEMANTIC_PRIMITIVE_PARAMETER_PROFILE_ID,
  );
  assert.equal(
    primitives.SEMANTIC_PRIMITIVE_PARAMETER_SCHEMA_VERSION,
    SEMANTIC_PRIMITIVE_PARAMETER_SCHEMA_VERSION,
  );
  assert.deepEqual(
    primitives.SEMANTIC_PRIMITIVE_PRESET_BY_GRAMMAR,
    SEMANTIC_PRIMITIVE_PRESET_BY_GRAMMAR,
  );
  assert.deepEqual(
    primitives.SEMANTIC_PRIMITIVE_STATE_TOKENS,
    SEMANTIC_PRIMITIVE_STATE_TOKENS,
  );
});
