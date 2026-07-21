"use strict";

const { createHash } = require("node:crypto");

const { AppError } = require("../../../errors.cjs");
const { stableStringify } = require("./canonical-json.cjs");
const {
  semanticVisualConceptRendererVariant,
} = require("./semantic-visual-concept-registry.cjs");

const SEMANTIC_VISUAL_COHERENCE_SCHEMA_VERSION = 1;
const SEMANTIC_VISUAL_COHERENCE_PROFILE_ID =
  "dark_curiosity_semantic_visual_coherence_v1";
const SEMANTIC_VISUAL_COHERENCE_THRESHOLDS = Object.freeze({
  minimumSequenceLength: 3,
  maximumConsecutiveIdenticalForms: 2,
  rollingWindowSize: 5,
  maximumIdenticalFormsPerWindow: 2,
  dominantShareMinimumSequenceLength: 4,
  maximumDominantSharePermille: 250,
  minimumDominantFormAllowance: 2,
});

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function canonicalHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function primaryVisualRendererVariant(sentence) {
  return semanticVisualConceptRendererVariant({
    visualConceptId: sentence?.primitiveParameters?.visualConceptId,
    grammarId: sentence?.capability?.grammarId,
    assetId: sentence?.capability?.assetId,
    stateTransition: sentence?.visualIntent?.stateTransition,
    stateToken: sentence?.primitiveParameters?.stateToken,
  });
}

function primaryVisualFormSignature(sentence) {
  const rendererVariant = primaryVisualRendererVariant(sentence);
  const assetId = sentence?.capability?.assetId;
  const grammarId = sentence?.capability?.grammarId;
  const recipeId = sentence?.sceneComposition?.geometryBlueprint?.recipeId;
  if ([rendererVariant, assetId, grammarId, recipeId].some((value) => (
    typeof value !== "string" || value.length === 0
  ))) return null;
  return `${rendererVariant}|${assetId}|${grammarId}|${recipeId}`;
}

function dominantFormAllowance(sentenceCount) {
  return Math.max(
    SEMANTIC_VISUAL_COHERENCE_THRESHOLDS.minimumDominantFormAllowance,
    Math.floor(
      sentenceCount
        * SEMANTIC_VISUAL_COHERENCE_THRESHOLDS.maximumDominantSharePermille
        / 1000,
    ),
  );
}

function maximumConsecutiveRun(signatures) {
  let maximum = 0;
  let current = 0;
  let previous = null;
  let startIndex = 0;
  let maximumStartIndex = 0;
  let maximumSignature = null;
  signatures.forEach((signature, index) => {
    if (signature === previous) {
      current += 1;
    } else {
      current = 1;
      startIndex = index;
      previous = signature;
    }
    if (current > maximum) {
      maximum = current;
      maximumStartIndex = startIndex;
      maximumSignature = signature;
    }
  });
  return {
    count: maximum,
    startSentenceIndex: maximumStartIndex,
    endSentenceIndex: maximum
      ? maximumStartIndex + maximum - 1
      : maximumStartIndex,
    signature: maximumSignature,
  };
}

function rollingWindowViolations(signatures) {
  const windowSize =
    SEMANTIC_VISUAL_COHERENCE_THRESHOLDS.rollingWindowSize;
  if (signatures.length < windowSize) return [];
  const violations = [];
  for (let start = 0; start <= signatures.length - windowSize; start += 1) {
    const counts = new Map();
    for (let offset = 0; offset < windowSize; offset += 1) {
      const signature = signatures[start + offset];
      counts.set(signature, (counts.get(signature) || 0) + 1);
    }
    for (const [signature, count] of counts) {
      if (
        count
          > SEMANTIC_VISUAL_COHERENCE_THRESHOLDS
            .maximumIdenticalFormsPerWindow
      ) {
        violations.push({
          code: "PRIMARY_FORM_OVERUSED_IN_ROLLING_WINDOW",
          signature,
          count,
          limit: SEMANTIC_VISUAL_COHERENCE_THRESHOLDS
            .maximumIdenticalFormsPerWindow,
          startSentenceIndex: start,
          endSentenceIndex: start + windowSize - 1,
        });
      }
    }
  }
  return violations;
}

function buildSemanticVisualCoherenceReport(sentencePlan) {
  const sentences = Array.isArray(sentencePlan?.sentences)
    ? sentencePlan.sentences
    : [];
  const signatures = sentences.map(primaryVisualFormSignature);
  const applicable = (
    typeof sentencePlan?.sceneCompositionProfileId === "string"
    && sentences.length > 0
    && signatures.every(Boolean)
  );
  const counts = new Map();
  if (applicable) {
    for (const signature of signatures) {
      counts.set(signature, (counts.get(signature) || 0) + 1);
    }
  }
  const orderedCounts = [...counts.entries()]
    .map(([signature, count]) => ({ signature, count }))
    .sort((left, right) => (
      right.count - left.count
      || left.signature.localeCompare(right.signature, "en")
    ));
  const dominant = orderedCounts[0] || { signature: null, count: 0 };
  const consecutive = maximumConsecutiveRun(
    applicable ? signatures : [],
  );
  const violations = applicable
    ? rollingWindowViolations(signatures)
    : [];
  if (
    applicable
    && sentences.length
      >= SEMANTIC_VISUAL_COHERENCE_THRESHOLDS.minimumSequenceLength
    && consecutive.count
      > SEMANTIC_VISUAL_COHERENCE_THRESHOLDS
        .maximumConsecutiveIdenticalForms
  ) {
    violations.push({
      code: "PRIMARY_FORM_CONSECUTIVE_RUN_EXCEEDED",
      signature: consecutive.signature,
      count: consecutive.count,
      limit: SEMANTIC_VISUAL_COHERENCE_THRESHOLDS
        .maximumConsecutiveIdenticalForms,
      startSentenceIndex: consecutive.startSentenceIndex,
      endSentenceIndex: consecutive.endSentenceIndex,
    });
  }
  const dominantAllowance = dominantFormAllowance(sentences.length);
  if (
    applicable
    && sentences.length
      >= SEMANTIC_VISUAL_COHERENCE_THRESHOLDS
        .dominantShareMinimumSequenceLength
    && dominant.count > dominantAllowance
  ) {
    violations.push({
      code: "PRIMARY_FORM_DOMINANT_SHARE_EXCEEDED",
      signature: dominant.signature,
      count: dominant.count,
      limit: dominantAllowance,
      startSentenceIndex: 0,
      endSentenceIndex: sentences.length - 1,
    });
  }
  violations.sort((left, right) => (
    left.startSentenceIndex - right.startSentenceIndex
    || left.endSentenceIndex - right.endSentenceIndex
    || left.code.localeCompare(right.code, "en")
    || left.signature.localeCompare(right.signature, "en")
  ));
  const report = {
    schemaVersion: SEMANTIC_VISUAL_COHERENCE_SCHEMA_VERSION,
    profileId: SEMANTIC_VISUAL_COHERENCE_PROFILE_ID,
    applicable,
    passed: violations.length === 0,
    sentenceCount: sentences.length,
    thresholds: { ...SEMANTIC_VISUAL_COHERENCE_THRESHOLDS },
    metrics: {
      distinctPrimaryFormCount: orderedCounts.length,
      dominantPrimaryFormSignature: dominant.signature,
      dominantPrimaryFormCount: dominant.count,
      dominantPrimaryFormSharePermille: sentences.length
        ? Math.floor(dominant.count * 1000 / sentences.length)
        : 0,
      dominantPrimaryFormAllowance: dominantAllowance,
      maximumConsecutiveIdenticalFormCount: consecutive.count,
      primaryFormCounts: orderedCounts,
    },
    violations,
  };
  return deepFreeze({ ...report, contentHash: canonicalHash(report) });
}

function assertSemanticVisualCoherence(sentencePlan) {
  const report = buildSemanticVisualCoherenceReport(sentencePlan);
  if (!report.passed) {
    throw new AppError(
      "ANIMATION_SEMANTIC_VISUAL_COHERENCE_INVALID",
      "The semantic visual plan repeats the same primary form too often to explain the narration clearly.",
      409,
      {
        reportHash: report.contentHash,
        violations: report.violations.slice(0, 12),
      },
    );
  }
  return report;
}

module.exports = {
  SEMANTIC_VISUAL_COHERENCE_PROFILE_ID,
  SEMANTIC_VISUAL_COHERENCE_SCHEMA_VERSION,
  SEMANTIC_VISUAL_COHERENCE_THRESHOLDS,
  assertSemanticVisualCoherence,
  buildSemanticVisualCoherenceReport,
  primaryVisualFormSignature,
  primaryVisualRendererVariant,
};
