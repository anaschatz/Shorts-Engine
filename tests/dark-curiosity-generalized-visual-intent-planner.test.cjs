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
  SEMANTIC_SCENE_COMPOSITION_LAYOUT_IDS,
  SEMANTIC_SCENE_COMPOSITION_MODULE_KINDS,
  SEMANTIC_SCENE_COMPOSITION_PROFILE_ID,
  SEMANTIC_SCENE_COMPOSITION_SCHEMA_VERSION,
  normalizeSemanticSceneComposition,
} = require("../server/pipelines/narrated-short/animation/semantic-scene-composition.cjs");
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
    assert.equal(repeated.plan.contentHash, compiled.plan.contentHash);
    assert.equal(repeated.animationIR.contentHash, compiled.animationIR.contentHash);
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

test("generalized semantic-v3 carries source-bound primitive parameters into visible renderer markup", async () => {
  const { compileAnimationIRToHtml } = await import(
    "../renderer/hyperframes/animation-ir-adapter.mjs"
  );
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
    assert.match(composition.html, /data-primitive-parameterized="true"/);
    assert.equal(
      [...composition.html.matchAll(/class="semantic-scene-composition"/g)].length,
      plan.sentences.length,
      id,
    );
    assert.equal(
      [...composition.html.matchAll(/data-scene-module-id="module_primary"/g)].length,
      plan.sentences.length,
      id,
    );
    assert.equal(
      [...composition.html.matchAll(/data-scene-module-id="module_support_a"/g)].length,
      plan.sentences.length,
      id,
    );
    assert.equal(
      [...composition.html.matchAll(/data-scene-module-id="module_support_b"/g)].length,
      plan.sentences.length,
      id,
    );
    assert.equal(
      [...composition.html.matchAll(
        /<g[^>]+class="[^"]*semantic-support-module[^"]*"[^>]*>/g,
      )].length,
      plan.sentences.length * 2,
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
      plan.sentences.length * 2,
      id,
    );
    for (const sentence of plan.sentences) {
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
  const rawA = readRaw("003_baychimo_icebound_drift");
  const rawB = structuredClone(rawA);
  const routeA = rawA.storyboard.scenes[3].operations[0].points;
  const routeB = [
    [0.12, 0.22],
    [0.35, 0.38],
    [0.66, 0.64],
    [0.88, 0.78],
  ];
  rawB.storyboard.scenes[3].operations[0].points = routeB;
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
  assert.notEqual(markup41, markup72);
  assert.doesNotMatch(markup72, />1023<|>0000<|>DATE<|>INPUT<|>OUTPUT</);
  assert.doesNotMatch(markup41, />1023<|>0000<|>DATE<|>INPUT<|>OUTPUT</);
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
  });
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
  assert.equal(rollover.primitiveParameters.stateToken, "REPEATS");

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
  assert.match(resetMarkup, /data-cycle-content="quantity"/);
  assert.match(
    resetMarkup,
    /class="counter-value cycle-quantity"[^>]*>ZERO<\/text>/,
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
  assert.match(newerMarkup, /COUNTER MORE[\s\S]*ROOM/);
  assert.match(newerMarkup, /while newer navigation[\s\S]*messages give/);

  const symbolicCycles = sentences.filter((sentence) => (
    sentence.capability.grammarId === "finite_cycle"
    && sentence.primitiveParameters.quantity === null
  ));
  assert.ok(symbolicCycles.length > 0);
  for (const sentence of symbolicCycles) {
    const markup = primitives.semanticSentencePrimitiveMarkup(
      sentence,
      sentences.indexOf(sentence),
    );
    assert.match(markup, /data-cycle-content="symbolic"/);
    assert.doesNotMatch(markup, /class="counter-value|class="counter-tick"/);
    assert.match(markup, new RegExp(`>${sentence.primitiveParameters.stateToken}<`));
    assert.match(
      markup,
      new RegExp(`data-cycle-symbol="${
        sentence.primitiveParameters.stateToken === "LIMIT"
          ? "limit"
          : sentence.primitiveParameters.stateToken === "REPEATS"
            ? "repeat"
            : "change"
      }"`),
    );
  }

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
    (tenBitMarkup.match(/class="counter-tick"/g) || []).length,
    10,
  );
  assert.match(tenBitMarkup, /data-cycle-content="quantity"/);
  assert.match(tenBitMarkup, />TEN BITS</);
  assert.doesNotMatch(
    tenBitMarkup,
    /semantic-cycle-pointer" transform-origin=/,
  );

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
    (twentyFourBitMarkup.match(/class="counter-tick"/g) || []).length,
    24,
  );

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
    ["leaving", /OF POSSIBLE[\s\S]*VALUES/],
    ["equipment", /SOFTWARE[\s\S]*PATCHES/],
    ["ordinary", /WAS[\s\S]*ORDINARY/],
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
      />(?:LEAVING|EQUIPMENT|ORDINARY)</,
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
  const affirmedCause = wowSentences.find((sentence) => (
    sentence.capability.grammarId === "cause_effect_chain"
    && sentence.primitiveParameters.stateToken === "RESULT"
  ));
  assert.ok(affirmedCause);
  const affirmedCauseMarkup = primitives.semanticSentencePrimitiveMarkup(
    affirmedCause,
    wowSentences.indexOf(affirmedCause),
  );
  assert.match(affirmedCauseMarkup, /data-cause-result="affirmed"/);
  assert.doesNotMatch(affirmedCauseMarkup, /class="semantic-draw error-cross"/);

  const reversedRoute = structuredClone(
    compileRaw(
      readRaw("003_baychimo_icebound_drift"),
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
    readRaw("003_baychimo_icebound_drift"),
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
  const escapedMarkup = primitives.semanticSentencePrimitiveMarkup(
    escapedSentence,
    0,
  );
  assert.match(escapedMarkup, /ARCHIVE A &amp; B &lt;COPY&gt;/);
  assert.doesNotMatch(escapedMarkup, /<copy>/i);

  const baychimo = compileRaw(
    readRaw("003_baychimo_icebound_drift"),
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
  const iceText = "The vessel vanished beside Arctic pack ice";
  iceOnlyAbsence.primitiveParameters.detail.value = iceText;
  iceOnlyAbsence.primitiveParameters.detail.sourceRef.value = iceText;
  iceOnlyAbsence.primitiveParameters.detail.sourceRef.endOffset =
    iceOnlyAbsence.primitiveParameters.detail.sourceRef.startOffset
      + iceText.length;
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
  const longWord = "Electromagnetically";
  longCause.primitiveParameters.detail.value = longWord;
  longCause.primitiveParameters.detail.sourceRef.value = longWord;
  longCause.primitiveParameters.detail.sourceRef.endOffset =
    longCause.primitiveParameters.detail.sourceRef.startOffset
      + longWord.length;
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
