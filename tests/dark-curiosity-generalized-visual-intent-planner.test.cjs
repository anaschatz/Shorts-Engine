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
} = require("../server/pipelines/narrated-short/animation/semantic-visual-sentence-planner.cjs");
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
    const composition = compileAnimationIRToHtml(compiled.animationIR);
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
  const composition = compileAnimationIRToHtml(compiled.animationIR);
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
    compileAnimationIRToHtml(compiled.animationIR).compositionHash,
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
});
