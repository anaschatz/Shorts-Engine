"use strict";

const { AppError } = require("../../../errors.cjs");
const {
  contentHash,
  normalizeDraftBundle,
} = require("../contracts.cjs");
const {
  buildSemanticEventGraph,
} = require("./semantic-event-graph.cjs");
const {
  normalizeSemanticEventGraph,
} = require("./semantic-event-validator.cjs");
const {
  findSemanticEventProfile,
} = require("./semantic-event-profile-registry.cjs");
const {
  buildGeneralizedSemanticArtifacts,
} = require("./generalized-semantic-event-planner.cjs");
const {
  SEMANTIC_SENTENCE_MAX_CLAIMS_PER_BEAT,
  SEMANTIC_SENTENCE_MAX_SENTENCES_PER_BEAT,
  SEMANTIC_SENTENCE_MAX_TOTAL_SENTENCES,
  SEMANTIC_SENTENCE_PROFILE_ID,
  SEMANTIC_SENTENCE_PROFILE_VERSION,
  SEMANTIC_SENTENCE_RENDERER,
  SEMANTIC_SENTENCE_ROLES,
  SEMANTIC_SENTENCE_SCHEMA_VERSION,
  SEMANTIC_SENTENCE_TEMPLATE_ID,
  SEMANTIC_SENTENCE_TEMPLATE_VERSION,
} = require("./semantic-render-profile.cjs");
const {
  buildSemanticVisualSentencePlan,
  normalizeSemanticVisualSentencePlan,
  validateSemanticVisualSentencePlanAgainstGraph,
} = require("./semantic-visual-sentence-planner.cjs");
const {
  normalizeAnimationTimingContext,
} = require("./timing-contract.cjs");

const ID_PATTERN = /^[a-z][a-z0-9_-]{2,79}$/;

function fail(field, reason) {
  throw new AppError(
    "ANIMATION_SEMANTIC_PRODUCTION_INVALID",
    "The semantic sentence animation cannot be compiled from this approved draft and timing.",
    409,
    { field, reason },
  );
}

function unique(values) {
  return [...new Set(values)];
}

function wrapText(value, maxCharacters = 22, maxLines = 2) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  for (const word of words) {
    const current = lines.at(-1);
    if (
      !current
      || (current.length + word.length + 1 > maxCharacters && lines.length < maxLines)
    ) {
      lines.push(word);
    } else {
      lines[lines.length - 1] = `${current} ${word}`;
    }
  }
  return (lines.length ? lines : ["UNTITLED"])
    .slice(0, maxLines)
    .map((line) => line.slice(0, 50));
}

function bounded(value, maximum, fallback) {
  const normalized = String(value || "").trim() || fallback;
  return normalized.slice(0, maximum);
}

function wordAnchor(anchor, wordIndex) {
  return { anchor, wordIndex };
}

function assertExplicitProfile(input) {
  if (input.semanticProfileId !== SEMANTIC_SENTENCE_PROFILE_ID) {
    fail("semanticProfileId", "explicit_semantic_v3_profile_required");
  }
}

function assertProjectBinding(input) {
  if (
    typeof input.projectId !== "string"
    || !ID_PATTERN.test(input.projectId)
    || !Number.isInteger(input.projectRevision)
    || input.projectRevision < 1
    || input.projectRevision > 1_000_000
  ) {
    fail("project", "valid_project_binding_required");
  }
}

function exactProfileArtifacts(input) {
  assertExplicitProfile(input);
  const draft = normalizeDraftBundle(input.draft);
  const timingContext = normalizeAnimationTimingContext(input.timingContext);
  if (
    draft.verticalId !== "dark_curiosity"
    || draft.brief.formatId !== "documented_mystery_v1"
  ) {
    fail("draft.brief.formatId", "documented_mystery_required");
  }
  if (draft.contentHash !== timingContext.draftHash) {
    fail("timingContext.draftHash", "draft_hash_mismatch");
  }
  const profile = findSemanticEventProfile({
    profileId: input.semanticProfileId,
    draftHash: draft.contentHash,
    alignmentHash: timingContext.alignmentHash,
  });
  if (profile) {
    if (timingContext.contentHash !== profile.timingContextHash) {
      fail("timingContext.contentHash", "exact_checked_in_timing_required");
    }
    const semanticEventGraph = normalizeSemanticEventGraph(buildSemanticEventGraph({
      draft,
      timingContext,
      manifest: profile.manifest,
    }));
    const semanticVisualSentencePlan = validateSemanticVisualSentencePlanAgainstGraph(
      normalizeSemanticVisualSentencePlan(
        buildSemanticVisualSentencePlan(semanticEventGraph),
      ),
      semanticEventGraph,
    );
    return {
      draft,
      profile,
      semanticEventGraph,
      semanticVisualSentencePlan,
      timingContext,
    };
  }
  const generalized = buildGeneralizedSemanticArtifacts({
    draft,
    timingContext,
  });
  const semanticEventGraph = normalizeSemanticEventGraph(generalized.semanticEventGraph);
  const semanticVisualSentencePlan = validateSemanticVisualSentencePlanAgainstGraph(
    normalizeSemanticVisualSentencePlan(
      buildSemanticVisualSentencePlan(semanticEventGraph),
    ),
    semanticEventGraph,
  );
  return {
    draft,
    profile: Object.freeze({
      id: "generalized_story_visual_intent_v1",
      profileId: SEMANTIC_SENTENCE_PROFILE_ID,
      draftHash: draft.contentHash,
      alignmentHash: timingContext.alignmentHash,
      timingContextHash: timingContext.contentHash,
      manifestHash: contentHash({
        storyIRHash: generalized.storyIR.contentHash,
        visualIntentGraphHash: generalized.visualIntentGraph.contentHash,
        semanticEventGraphHash: semanticEventGraph.contentHash,
      }),
    }),
    semanticEventGraph,
    semanticVisualSentencePlan,
    timingContext,
  };
}

function beatProductionScenes(artifacts) {
  const {
    draft,
    semanticVisualSentencePlan,
    timingContext,
  } = artifacts;
  if (
    timingContext.beats.length !== SEMANTIC_SENTENCE_ROLES.length
    || draft.script.beats.length !== SEMANTIC_SENTENCE_ROLES.length
  ) {
    fail("timingContext.beats", "exactly_five_narrative_beats_required");
  }
  if (
    semanticVisualSentencePlan.sentences.length < SEMANTIC_SENTENCE_ROLES.length
    || semanticVisualSentencePlan.sentences.length > SEMANTIC_SENTENCE_MAX_TOTAL_SENTENCES
  ) {
    fail("semanticVisualSentencePlan.sentences", "total_sentence_cap_exceeded");
  }

  const sentenceIds = new Set();
  const operationTargetIds = new Set();
  return SEMANTIC_SENTENCE_ROLES.map((role, index) => {
    const draftBeat = draft.script.beats[index];
    const timingBeat = timingContext.beats[index];
    if (
      draftBeat?.role !== role
      || timingBeat?.beatId !== draftBeat?.id
    ) {
      fail(`beats[${index}]`, "role_and_timing_order_mismatch");
    }
    const sentences = semanticVisualSentencePlan.sentences.filter(
      (sentence) => sentence.beatId === timingBeat.beatId,
    );
    if (
      sentences.length < 1
      || sentences.length > SEMANTIC_SENTENCE_MAX_SENTENCES_PER_BEAT
    ) {
      fail(`beats[${index}].sentences`, "sentence_cap_exceeded");
    }
    const claimIds = unique(sentences.flatMap((sentence) => sentence.claimIds));
    if (
      claimIds.length < 1
      || claimIds.length > SEMANTIC_SENTENCE_MAX_CLAIMS_PER_BEAT
    ) {
      fail(`beats[${index}].claimIds`, "claim_cap_exceeded");
    }
    const sceneStart = index === 0 ? 0 : timingBeat.startFrame;
    const sceneEnd = index === SEMANTIC_SENTENCE_ROLES.length - 1
      ? timingContext.durationFrames
      : timingContext.beats[index + 1].startFrame;

    for (const [sentenceIndex, sentence] of sentences.entries()) {
      const field = `beats[${index}].sentences[${sentenceIndex}]`;
      if (
        sentence.wordSpan.startFrame < timingBeat.startFrame
        || sentence.wordSpan.endFrame > timingBeat.endFrame
        || sentence.wordSpan.startWordIndex < timingBeat.wordStartIndex
        || sentence.wordSpan.endWordIndex > timingBeat.wordEndIndex
      ) {
        fail(`${field}.wordSpan`, "sentence_outside_exact_beat_cue");
      }
      const firstWord = timingContext.words[sentence.wordSpan.startWordIndex];
      const lastWord = timingContext.words[sentence.wordSpan.endWordIndex - 1];
      if (
        firstWord.startFrame !== sentence.wordSpan.startFrame
        || lastWord.endFrame !== sentence.wordSpan.endFrame
      ) {
        fail(`${field}.wordSpan`, "sentence_cue_frame_mismatch");
      }
      if (sentence.wordSpan.text.length > 120) {
        fail(`${field}.wordSpan.text`, "sentence_entity_text_too_long");
      }
      if (sentenceIds.has(sentence.id) || operationTargetIds.has(sentence.id)) {
        fail(`${field}.id`, "sentence_target_not_unique");
      }
      sentenceIds.add(sentence.id);
      operationTargetIds.add(sentence.id);
    }

    const entityIds = sentences.map((sentence) => sentence.id);
    const operations = sentences.map((sentence) => ({
      op: "create",
      targetId: sentence.id,
      from: wordAnchor("word_start", sentence.wordSpan.startWordIndex),
      to: wordAnchor("word_end", sentence.wordSpan.endWordIndex - 1),
      easing: "linear",
      params: { opacity: 1 },
      semanticClaimId: sentence.claimIds[0],
      visualStatement: sentence.wordSpan.text,
      carryPolicy: "clear_at_scene_end",
    }));
    const lastCueEnd = sentences.at(-1).wordSpan.endFrame;
    if (lastCueEnd >= sceneEnd) {
      fail(`beats[${index}].readabilityHold`, "settled_tail_required");
    }
    return {
      id: `scene_${role}`,
      startFrame: sceneStart,
      endFrame: sceneEnd,
      template: SEMANTIC_SENTENCE_TEMPLATE_ID,
      templateVersion: SEMANTIC_SENTENCE_TEMPLATE_VERSION,
      semantic: {
        beatId: timingBeat.beatId,
        role,
        claimIds,
        visualStatement: `Render ${sentences.length} exact graph-bound narration sentences.`,
      },
      entityIds,
      operations,
      readabilityHolds: [{
        startFrame: lastCueEnd,
        endFrame: sceneEnd,
      }],
      complexityCost: operations.length,
    };
  });
}

function buildContent(artifacts) {
  const {
    draft,
    semanticEventGraph,
    semanticVisualSentencePlan,
  } = artifacts;
  const sentences = semanticVisualSentencePlan.sentences;
  const sentencesByBeat = new Map();
  for (const sentence of sentences) {
    const values = sentencesByBeat.get(sentence.beatId) || [];
    values.push(sentence);
    sentencesByBeat.set(sentence.beatId, values);
  }
  const first = sentences[0];
  const last = sentences.at(-1);
  const context = sentencesByBeat.get(draft.script.beats[1].id)?.[0] || first;
  const evidence = sentencesByBeat.get(draft.script.beats[2].id)?.[0] || context;
  const payoff = sentencesByBeat.get(draft.script.beats[4].id) || [last];
  const payoffFirst = payoff[0];
  const payoffLast = payoff.at(-1);
  const firstQuantity = semanticEventGraph.propositions
    .flatMap((proposition) => proposition.quantities)
    .find((quantity) => quantity.value);
  const timelineLabels = draft.script.beats.map((beat) => bounded(
    sentencesByBeat.get(beat.id)?.[0]?.wordSpan.text,
    24,
    beat.onScreenText,
  ).toUpperCase());
  return {
    compositionId: `dcv3_${semanticVisualSentencePlan.contentHash.slice(0, 22)}`,
    kicker: "SEMANTIC EVENT GRAPH",
    titleLines: wrapText(draft.script.title.toUpperCase(), 20, 2),
    metricValue: bounded(firstQuantity?.value, 32, String(sentences.length)).toUpperCase(),
    metricLabel: bounded(context.wordSpan.text, 72, "EXACT NARRATION CUE").toUpperCase(),
    evidenceCode: bounded(evidence.capability.assetId, 32, "SEMANTIC VISUAL").toUpperCase(),
    evidenceLabel: bounded(evidence.wordSpan.text, 72, "GRAPH-BOUND EVIDENCE").toUpperCase(),
    reasoningLeft: bounded(payoffFirst.wordSpan.text, 50, "SUPPORTED").toUpperCase(),
    reasoningRight: bounded(payoffLast.wordSpan.text, 50, "BOUNDED").toUpperCase(),
    payoffLines: wrapText(payoffLast.wordSpan.text.toUpperCase(), 24, 2),
    timelineLabels,
    semantic: {
      profileId: SEMANTIC_SENTENCE_PROFILE_ID,
      narrativeShape: semanticEventGraph.narrativeShape,
      subjectLabel: bounded(draft.script.title, 80, "Documented mystery").toUpperCase(),
      uncertaintyLabel: bounded(payoffLast.wordSpan.text, 80, "UNCERTAINTY BOUNDED").toUpperCase(),
      finalEvidenceLabel: bounded(last.wordSpan.text, 80, "FINAL EVIDENCE").toUpperCase(),
      semanticEventGraphHash: semanticEventGraph.contentHash,
      semanticVisualSentencePlanHash: semanticVisualSentencePlan.contentHash,
    },
    semanticEventGraph,
    semanticVisualSentencePlan,
  };
}

function buildSharedEntities(semanticVisualSentencePlan) {
  return semanticVisualSentencePlan.sentences
    .map((sentence, index) => ({
      id: sentence.id,
      type: "semantic_visual",
      role: sentence.visualIntent.subjectKind,
      layer: 2 + (index % 6),
      styleToken: sentence.capability.grammarId,
      text: sentence.wordSpan.text,
    }));
}

function buildSemanticSentenceProductionAnimationPlan(input = {}) {
  assertProjectBinding(input);
  const artifacts = exactProfileArtifacts(input);
  const scenes = beatProductionScenes(artifacts);
  const content = buildContent(artifacts);
  const sharedEntities = buildSharedEntities(
    artifacts.semanticVisualSentencePlan,
  );
  if (
    sharedEntities.length
      !== scenes.reduce((total, scene) => total + scene.operations.length, 0)
    || new Set(sharedEntities.map((entity) => entity.id)).size !== sharedEntities.length
  ) {
    fail("sharedEntities", "one_entity_and_operation_per_sentence_required");
  }
  const assetManifestHash = contentHash({
    profileId: SEMANTIC_SENTENCE_PROFILE_ID,
    profileVersion: SEMANTIC_SENTENCE_PROFILE_VERSION,
    renderer: SEMANTIC_SENTENCE_RENDERER,
    templateId: SEMANTIC_SENTENCE_TEMPLATE_ID,
    templateVersion: SEMANTIC_SENTENCE_TEMPLATE_VERSION,
    registryManifestHash: artifacts.profile.manifestHash,
    registryTimingContextHash: artifacts.profile.timingContextHash,
    semanticEventGraphHash: artifacts.semanticEventGraph.contentHash,
    semanticVisualSentencePlanHash:
      artifacts.semanticVisualSentencePlan.contentHash,
  });
  const seed = Number.parseInt(contentHash({
    assetManifestHash,
    projectId: input.projectId,
    projectRevision: input.projectRevision,
  }).slice(0, 8), 16) >>> 0;
  const dimensions = input.renderProfile === "final"
    ? { width: 1080, height: 1920 }
    : { width: 720, height: 1280 };
  return {
    schemaVersion: SEMANTIC_SENTENCE_SCHEMA_VERSION,
    profile: "dark_curiosity_continuous",
    profileVersion: SEMANTIC_SENTENCE_PROFILE_VERSION,
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    verticalId: "dark_curiosity",
    ...dimensions,
    fps: artifacts.timingContext.fps,
    durationFrames: artifacts.timingContext.durationFrames,
    draftHash: artifacts.draft.contentHash,
    alignmentHash: artifacts.timingContext.alignmentHash,
    assetManifestHash,
    renderer: { ...SEMANTIC_SENTENCE_RENDERER },
    seed,
    content,
    sharedEntities,
    scenes,
    transitions: [],
    motionBudget: {
      profile: "dark_curiosity",
      maxCost: SEMANTIC_SENTENCE_MAX_TOTAL_SENTENCES,
      maxConcurrentOperations: 1,
      maxCameraScale: 1.15,
      maxTravelPxPerFrame: 12,
      captionSafeZone: { topRatio: 0.74, bottomRatio: 1 },
    },
  };
}

module.exports = {
  buildSemanticSentenceProductionAnimationPlan,
};
