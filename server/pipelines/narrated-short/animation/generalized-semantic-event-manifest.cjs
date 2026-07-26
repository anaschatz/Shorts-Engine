"use strict";

const { AppError } = require("../../../errors.cjs");
const { stableStringify } = require("./canonical-json.cjs");
const {
  VISUAL_INTENT_PRIMITIVE_PAYLOAD_PROFILE_ID,
} = require("./generalized-visual-intent-planner.cjs");

const PRIMITIVE_SOURCE_FIELDS = Object.freeze([
  "text",
  "label",
  "date",
  "leftLabel",
  "rightLabel",
]);
const NUMBER_WORDS = new Set([
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
]);
const QUANTITY_UNITS = new Set([
  "bit",
  "bits",
  "day",
  "days",
  "hour",
  "hours",
  "hz",
  "hertz",
  "minute",
  "minutes",
  "month",
  "months",
  "second",
  "seconds",
  "week",
  "weeks",
  "year",
  "years",
]);

function fail(field, reason) {
  throw new AppError(
    "ANIMATION_GENERALIZED_SEMANTIC_INVALID",
    "The generalized semantic payload is not grounded in the approved story.",
    409,
    { field, reason },
  );
}

function sourceRef(sourceType, sourceId, field, value, operationIndex = null) {
  return {
    sourceType,
    sourceId,
    operationIndex,
    field,
    startOffset: 0,
    endOffset: value.length,
    value,
  };
}

function storyboardValueRef(draft, primitivePayload) {
  const scene = draft.storyboard.scenes.find(
    (entry) => entry.id === primitivePayload.sourceSceneId,
  );
  if (!scene) fail("primitivePayload.sourceSceneId", "source_scene_not_found");
  for (const operationIndex of primitivePayload.sourceOperationIndexes) {
    const operation = scene.operations[operationIndex];
    if (!operation) fail("primitivePayload.sourceOperationIndexes", "source_operation_not_found");
    for (const field of PRIMITIVE_SOURCE_FIELDS) {
      if (operation[field] === primitivePayload.detail) {
        return sourceRef(
          "storyboard_operation",
          scene.id,
          field,
          primitivePayload.detail,
          operationIndex,
        );
      }
    }
  }
  if (scene.disclosure === primitivePayload.detail) {
    return sourceRef(
      "storyboard_scene",
      scene.id,
      "disclosure",
      primitivePayload.detail,
    );
  }
  fail("primitivePayload.detail", "exact_storyboard_source_required");
}

function routeGeometryBinding(draft, primitivePayload) {
  if (!primitivePayload.geometry.points) return null;
  const scene = draft.storyboard.scenes.find(
    (entry) => entry.id === primitivePayload.sourceSceneId,
  );
  const operationIndex = primitivePayload.sourceOperationIndexes.find((index) => {
    const operation = scene?.operations[index];
    return operation?.op === "draw_route"
      && stableStringify(operation.points)
        === stableStringify(primitivePayload.geometry.points);
  });
  if (operationIndex === undefined) {
    fail("primitivePayload.geometry", "exact_route_operation_required");
  }
  return {
    kind: "route_points",
    sourceSceneId: scene.id,
    operationIndex,
    points: structuredClone(primitivePayload.geometry.points),
  };
}

function fragmentRef(ref, startIndex, endIndex) {
  return {
    ...structuredClone(ref),
    startOffset: ref.startOffset + startIndex,
    endOffset: ref.startOffset + endIndex,
    value: ref.value.slice(startIndex, endIndex),
  };
}

function isNumberWordToken(token) {
  return token.normalized
    .split("-")
    .every((part) => NUMBER_WORDS.has(part));
}

function isNumberConnector(tokens, index) {
  return tokens[index]?.normalized === "and"
    && isNumberWordToken(tokens[index + 1] || { normalized: "" });
}

function quantityTokens(ref) {
  const tokens = [...ref.value.matchAll(/[A-Za-z0-9]+(?:[.,:-][A-Za-z0-9]+)*/g)]
    .map((match) => ({
      value: match[0],
      index: match.index,
      endIndex: match.index + match[0].length,
      normalized: match[0].toLocaleLowerCase("en-US").replace(/[.,:-]+$/g, ""),
    }));
  const output = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const numericToken = /^\d/.test(token.normalized);
    const numberWordToken = isNumberWordToken(token);
    if (!numericToken && !numberWordToken) continue;

    let valueEndIndex = index;
    if (numberWordToken) {
      while (valueEndIndex + 1 < tokens.length) {
        if (isNumberWordToken(tokens[valueEndIndex + 1])) {
          valueEndIndex += 1;
          continue;
        }
        if (isNumberConnector(tokens, valueEndIndex + 1)) {
          valueEndIndex += 2;
          continue;
        }
        break;
      }
    }
    const valueEndToken = tokens[valueEndIndex];
    const unitToken = tokens[valueEndIndex + 1];
    const hasUnit = unitToken && QUANTITY_UNITS.has(unitToken.normalized);
    output.push({
      value: ref.value.slice(token.index, valueEndToken.endIndex),
      unit: hasUnit ? unitToken.value : null,
      valueSourceRef: fragmentRef(ref, token.index, valueEndToken.endIndex),
      unitSourceRef: hasUnit
        ? fragmentRef(ref, unitToken.index, unitToken.endIndex)
        : null,
    });
    index = valueEndIndex;
  }
  return output;
}

function groundedQuantities(refs) {
  const quantities = [];
  const signatures = new Set();
  for (const ref of refs) {
    for (const quantity of quantityTokens(ref)) {
      const signature = stableStringify(quantity);
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      quantities.push(quantity);
      if (quantities.length === 8) return quantities;
    }
  }
  return quantities;
}

const TRANSITION_TARGETS = Object.freeze(new Set([
  "change_value",
  "repeat_cycle",
  "reset_to_origin",
  "wrap_to_origin",
]));

function isTransitionTargetQuantity(quantity, intent, cueRef) {
  if (!TRANSITION_TARGETS.has(intent.visualIntent.stateTransition)) return false;
  const startOffset = quantity.valueSourceRef.startOffset - cueRef.startOffset;
  if (startOffset < 0 || startOffset > cueRef.value.length) return false;
  const prefix = cueRef.value
    .slice(Math.max(0, startOffset - 64), startOffset)
    .toLocaleLowerCase("en-US");
  return /\b(?:change(?:d|s)?|reset(?:s)?|return(?:ed|s)?|roll(?:ed|s)?\s+over|wrap(?:ped|s)?)\b(?:(?![.!?;:]).){0,48}\b(?:back\s+)?to\s*$/.test(
    prefix,
  );
}

function displayQuantityScore(quantity, intent, cueRef) {
  const transitionTarget = isTransitionTargetQuantity(quantity, intent, cueRef);
  const predicate = intent.visualIntent.predicate;
  const hasExplicitDigits = /\d/.test(quantity.value);
  const hasUnit = Boolean(quantity.unit);
  let semanticPriority = 0;
  if (transitionTarget) {
    semanticPriority = 100;
  } else if (
    ["bounded_uncertainty", "negation"].includes(predicate)
  ) {
    semanticPriority = 0;
  } else if (predicate === "capacity_limit") {
    semanticPriority = hasUnit ? 90 : 70;
  } else if (["recurrence", "state_change"].includes(predicate)) {
    semanticPriority = hasUnit || hasExplicitDigits ? 80 : 0;
  } else if (["appearance", "last_known_record"].includes(predicate)) {
    semanticPriority = hasExplicitDigits ? 70 : 0;
  } else if (
    predicate === "comparison"
    || intent.eventKind === "measured_extent"
  ) {
    semanticPriority = hasUnit ? 80 : 60;
  } else if (hasUnit) {
    semanticPriority = 50;
  }
  if (semanticPriority === 0) return null;
  return (
    semanticPriority * 1_000_000
    + (hasUnit ? 10_000 : 0)
    + (hasExplicitDigits ? 1_000 : 0)
    + quantity.value.trim().split(/\s+/).length * 100
    + quantity.value.length
  );
}

function narrationCueSourceRef(beat, timingBeat, wordSpan) {
  const words = beat.spokenText.split(/\s+/).filter(Boolean);
  const localStart = wordSpan.startWordIndex - timingBeat.wordStartIndex;
  const localEnd = wordSpan.endWordIndex - timingBeat.wordStartIndex;
  const startOffset = localStart === 0
    ? 0
    : words.slice(0, localStart).join(" ").length + 1;
  const endOffset = words.slice(0, localEnd).join(" ").length;
  const value = beat.spokenText.slice(startOffset, endOffset);
  return {
    sourceType: "beat",
    sourceId: beat.id,
    operationIndex: null,
    field: "spokenText",
    startOffset,
    endOffset,
    value,
  };
}

function buildGeneralizedSemanticEventManifest(draft, timingContext, visualIntentGraph) {
  const beatById = new Map(draft.script.beats.map((beat) => [beat.id, beat]));
  const timingByBeatId = new Map(timingContext.beats.map((beat) => [beat.beatId, beat]));
  const entities = visualIntentGraph.entities.map((entity) => {
    const labelBeat = beatById.get(entity.labelBeatId);
    return {
      id: entity.id,
      kind: entity.subjectKind,
      visualSubjectKind: entity.subjectKind,
      label: entity.label,
      persistent: entity.persistent,
      claimIds: structuredClone(entity.claimIds),
      sourceRefs: [sourceRef(
        "beat",
        labelBeat.id,
        "onScreenText",
        labelBeat.onScreenText,
      )],
    };
  });
  const propositions = visualIntentGraph.intents.map((intent) => {
    const beat = beatById.get(intent.beatId);
    const timingBeat = timingByBeatId.get(intent.beatId);
    const cueRef = narrationCueSourceRef(beat, timingBeat, intent.wordSpan);
    const headlineRef = sourceRef(
      "beat",
      beat.id,
      "onScreenText",
      intent.primitivePayload.headline,
    );
    const detailRef = intent.primitivePayload.detail === cueRef.value
      ? structuredClone(cueRef)
      : storyboardValueRef(draft, intent.primitivePayload);
    const cueQuantities = quantityTokens(cueRef);
    const quantities = groundedQuantities([cueRef, headlineRef, detailRef]);
    const displayQuantity = cueQuantities.reduce((best, quantity) => {
      const score = displayQuantityScore(quantity, intent, cueRef);
      if (score === null) return best;
      return !best || score > best.score ? { quantity, score } : best;
    }, null)?.quantity || null;
    return {
      id: `proposition_${intent.role}_${intent.segmentIndex}`,
      beatId: intent.beatId,
      claimIds: structuredClone(intent.claimIds),
      wordSpan: structuredClone(intent.wordSpan),
      eventKind: intent.eventKind,
      predicate: intent.semanticPredicate,
      polarity: intent.polarity,
      epistemicStatus: intent.epistemicStatus,
      subject: { entityId: intent.entityId },
      object: { entityIds: [], value: null, sourceRef: null },
      state: { before: [], after: [] },
      attributes: [],
      quantities,
      certainty: intent.certainty,
      visualIntent: {
        focusEntityId: intent.entityId,
        ...structuredClone(intent.visualIntent),
      },
      visualAction: {
        operation: intent.visualAction,
        focusEntityIds: [intent.entityId],
      },
      sourceRefs: [cueRef],
      primitivePayload: {
        profileId: VISUAL_INTENT_PRIMITIVE_PAYLOAD_PROFILE_ID,
        headline: {
          value: intent.primitivePayload.headline,
          sourceRef: headlineRef,
        },
        detail: {
          value: intent.primitivePayload.detail,
          sourceRef: detailRef,
        },
        displayQuantity: displayQuantity
          ? structuredClone(displayQuantity)
          : null,
        geometry: routeGeometryBinding(draft, intent.primitivePayload),
      },
    };
  });
  const epistemicConstraints = visualIntentGraph.intents
    .filter((intent) => intent.certainty !== "verified")
    .map((intent) => ({
      id: `constraint_${intent.role}_${intent.segmentIndex}`,
      rule: "Preserve the approved uncertainty and do not convert interpretation into fact.",
      claimIds: structuredClone(intent.claimIds),
    }));
  return {
    primitivePayloadProfileId: VISUAL_INTENT_PRIMITIVE_PAYLOAD_PROFILE_ID,
    storyFormat: visualIntentGraph.storyFormat,
    narrativeShape: visualIntentGraph.narrativeShape,
    entities,
    propositions,
    continuity: structuredClone(visualIntentGraph.continuity),
    epistemicConstraints,
  };
}

module.exports = {
  buildGeneralizedSemanticEventManifest,
  groundedQuantities,
  narrationCueSourceRef,
  quantityTokens,
  routeGeometryBinding,
  sourceRef,
  storyboardValueRef,
};
