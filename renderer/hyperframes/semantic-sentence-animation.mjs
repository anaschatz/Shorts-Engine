import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  SUPPORTED_SEMANTIC_SENTENCE_ASSETS,
  SUPPORTED_SEMANTIC_SENTENCE_GRAMMARS,
  escapeSemanticSentenceXml,
  normalizeSemanticPrimitiveParameters,
  semanticSimpleExplainerHeading,
  semanticSentenceGeometryKind,
  semanticSentencePrimitiveMarkup,
} from "./primitives/semantic-sentence-primitives.mjs";
import {
  SEMANTIC_SCENE_COMPOSITION_PROFILE_ID,
  SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID,
  normalizeSemanticSceneComposition,
} from "./primitives/semantic-scene-composition.mjs";
import {
  compileSemanticSceneActionSchedule,
  compileSemanticSimpleExplainerGroupActionSchedule,
  semanticSceneActionQaPlan,
  semanticSceneActionRuntimeSource,
} from "./semantic-scene-action-schedule.mjs";

const require = createRequire(import.meta.url);
const {
  validateSemanticVisualSentencePlanAgainstGraph,
} = require(
  "../../server/pipelines/narrated-short/animation/semantic-visual-sentence-planner.cjs",
);
const {
  validateSemanticEventGraphAgainstDraft,
} = require(
  "../../server/pipelines/narrated-short/animation/semantic-event-graph.cjs",
);
const {
  CHECKED_UNPARAMETERIZED_SEMANTIC_EVENT_GRAPH_HASHES,
  CHECKED_UNPARAMETERIZED_SEMANTIC_SENTENCE_PLAN_HASHES,
} = require(
  "../../server/pipelines/narrated-short/animation/semantic-event-validator.cjs",
);
const {
  validateSemanticAnimationSceneDslPlanAgainstContext,
} = require(
  "../../server/pipelines/narrated-short/animation/semantic-animation-scene-dsl-plan.cjs",
);
const {
  buildSemanticSimpleExplainerGroups,
  semanticSimpleExplainerPresentationTiming,
} = require(
  "../../server/pipelines/narrated-short/animation/semantic-simple-explainer.cjs",
);
const BASE_WIDTH = 720;
const BASE_HEIGHT = 1280;
const FONT_FAMILY = "Outfit";
const FONT_LICENSE = "SIL Open Font License 1.1";
const FONT_BYTES = readFileSync(
  require.resolve("@fontsource/outfit/files/outfit-latin-600-normal.woff2"),
);
const FONT_BASE64 = FONT_BYTES.toString("base64");
const FONT_SHA256 = createHash("sha256").update(FONT_BYTES).digest("hex");
const REMOTE_URL = /\bhttps?:\/\//i;
const SAFE_ID = /^[a-z][a-z0-9_-]{1,79}$/;
const HASH = /^[a-f0-9]{64}$/;

export const SEMANTIC_SENTENCE_ANIMATION_SCHEMA_VERSION = 3;
export const SEMANTIC_SENTENCE_ANIMATION_PROFILE = "dark_curiosity_continuous";
export const SEMANTIC_SENTENCE_ANIMATION_PROFILE_VERSION = "1.5.0";
export const SEMANTIC_SENTENCE_ANIMATION_PROVIDER = "hyperframes_local";
export const SEMANTIC_SENTENCE_ANIMATION_RUNTIME_VERSION = "0.7.55";
export const SEMANTIC_SENTENCE_ANIMATION_STYLE_VERSION = "3.2.0";
export const SEMANTIC_SENTENCE_CONTENT_PROFILE_ID =
  "dark_curiosity_semantic_sentences_v3";
export const SEMANTIC_VISUAL_SENTENCE_PLAN_PROFILE_ID =
  "dark_curiosity_semantic_visual_sentence_plan_v1";

export const SUPPORTED_SEMANTIC_SENTENCE_GRAMMAR_ASSET_BINDINGS = Object.freeze({
  before_after: Object.freeze(["calendar_card"]),
  bounded_uncertainty: Object.freeze([
    "hypothesis_card",
    "uncertainty_boundary",
  ]),
  cause_effect_chain: Object.freeze([
    "calendar_card",
    "finite_counter",
    "mapping_table",
    "receiver_device",
  ]),
  chronology_accumulation: Object.freeze([
    "archive_record",
    "timeline_axis",
  ]),
  evidence_inspection: Object.freeze(["archive_record"]),
  finite_cycle: Object.freeze(["finite_counter"]),
  map_motion: Object.freeze(["vessel", "witness_marker"]),
  negative_space_absence: Object.freeze(["vessel"]),
  side_by_side_comparison: Object.freeze([
    "finite_counter",
    "hypothesis_card",
    "timeline_axis",
    "vessel",
  ]),
});

function fail(message) {
  throw new TypeError(message);
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value;
}

function safeText(value, label, {
  maximum = 240,
  pattern = null,
  optional = false,
} = {}) {
  if (optional && (value === undefined || value === null || value === "")) return "";
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
    || REMOTE_URL.test(value)
    || (pattern && !pattern.test(value))
  ) {
    fail(`${label} must be bounded safe text.`);
  }
  return value;
}

function safeId(value, label) {
  return safeText(value, label, { maximum: 80, pattern: SAFE_ID });
}

function hash(value, label) {
  return safeText(value, label, { maximum: 64, pattern: HASH });
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function contentHash(value) {
  const copy = structuredClone(value);
  delete copy.contentHash;
  return createHash("sha256").update(stableStringify(copy)).digest("hex");
}

function integer(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${label} is out of range.`);
  }
  return value;
}

function stringArray(value, label, {
  minimum = 0,
  maximum = 12,
  pattern = SAFE_ID,
} = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(`${label} must be a bounded array.`);
  }
  const normalized = value.map((entry, index) => safeText(
    entry,
    `${label}[${index}]`,
    { maximum: 120, pattern },
  ));
  if (new Set(normalized).size !== normalized.length) {
    fail(`${label} cannot contain duplicates.`);
  }
  return Object.freeze(normalized);
}

function normalizeSentence(input, index, durationFrames) {
  const sentence = plainObject(input, `Sentence ${index}`);
  const wordSpan = plainObject(sentence.wordSpan, `Sentence ${index} word span`);
  const startFrame = integer(
    wordSpan.startFrame,
    `Sentence ${index} start frame`,
    0,
    durationFrames - 1,
  );
  const endFrame = integer(
    wordSpan.endFrame,
    `Sentence ${index} end frame`,
    startFrame + 1,
    durationFrames,
  );
  const capability = plainObject(sentence.capability, `Sentence ${index} capability`);
  const assetId = safeId(capability.assetId, `Sentence ${index} asset`);
  const grammarId = safeId(capability.grammarId, `Sentence ${index} grammar`);
  if (!SUPPORTED_SEMANTIC_SENTENCE_ASSETS.includes(assetId)) {
    fail(`Sentence ${index} asset is unsupported.`);
  }
  if (!SUPPORTED_SEMANTIC_SENTENCE_GRAMMARS.includes(grammarId)) {
    fail(`Sentence ${index} grammar is unsupported.`);
  }
  if (!SUPPORTED_SEMANTIC_SENTENCE_GRAMMAR_ASSET_BINDINGS[grammarId]?.includes(assetId)) {
    fail(`Sentence ${index} asset and grammar are incompatible.`);
  }
  const primitiveParameters = sentence.primitiveParameters === undefined
    ? null
    : normalizeSemanticPrimitiveParameters(sentence.primitiveParameters);
  const sceneComposition = sentence.sceneComposition === undefined
    ? null
    : normalizeSemanticSceneComposition(sentence.sceneComposition);
  if (Boolean(primitiveParameters) !== Boolean(sceneComposition)) {
    fail(
      `Sentence ${index} primitive parameters and scene composition must be supplied together.`,
    );
  }
  if (
    primitiveParameters
    && (
      primitiveParameters.grammarId !== grammarId
      || primitiveParameters.assetId !== assetId
    )
  ) fail(`Sentence ${index} primitive parameters are bound to another capability.`);
  const visualIntent = plainObject(
    sentence.visualIntent,
    `Sentence ${index} visual intent`,
  );
  const focusEntity = plainObject(
    sentence.focusEntity,
    `Sentence ${index} focus entity`,
  );
  const focusEntityId = safeId(
    visualIntent.focusEntityId,
    `Sentence ${index} visual focus`,
  );
  if (safeId(focusEntity.id, `Sentence ${index} focus entity id`) !== focusEntityId) {
    fail(`Sentence ${index} visual focus is inconsistent.`);
  }
  if (typeof focusEntity.persistent !== "boolean") {
    fail(`Sentence ${index} persistence flag is invalid.`);
  }
  const subjectKind = safeId(
    visualIntent.subjectKind,
    `Sentence ${index} subject kind`,
  );
  if (
    safeId(
      focusEntity.visualSubjectKind,
      `Sentence ${index} focus subject kind`,
    ) !== subjectKind
  ) {
    fail(`Sentence ${index} visual subject is inconsistent.`);
  }
  const normalized = {
    id: safeId(sentence.id, `Sentence ${index} id`),
    propositionId: safeId(
      sentence.propositionId,
      `Sentence ${index} proposition id`,
    ),
    beatId: safeId(sentence.beatId, `Sentence ${index} beat id`),
    claimIds: stringArray(
      sentence.claimIds,
      `Sentence ${index} claim ids`,
      { minimum: 1, maximum: 6 },
    ),
    wordSpan: Object.freeze({
      startFrame,
      endFrame,
      text: safeText(wordSpan.text, `Sentence ${index} narration`, {
        maximum: 220,
      }),
    }),
    visualIntent: Object.freeze({
      focusEntityId,
      predicate: safeId(
        visualIntent.predicate,
        `Sentence ${index} predicate`,
      ),
      subjectKind,
      stateTransition: safeId(
        visualIntent.stateTransition,
        `Sentence ${index} state transition`,
      ),
    }),
    focusEntity: Object.freeze({
      id: focusEntityId,
      visualSubjectKind: subjectKind,
      persistent: focusEntity.persistent,
    }),
    capability: Object.freeze({ assetId, grammarId }),
    ...(primitiveParameters ? { primitiveParameters } : {}),
    ...(sceneComposition ? { sceneComposition } : {}),
  };
  if (normalized.id !== `vs_${normalized.propositionId}`) {
    fail(`Sentence ${index} id is not bound to its proposition.`);
  }
  if (
    sceneComposition
    && sceneComposition.id !== `composition_${normalized.propositionId}`
  ) {
    fail(`Sentence ${index} scene composition is not bound to its proposition.`);
  }
  return Object.freeze({
    ...normalized,
    geometryKind: semanticSentenceGeometryKind(normalized),
  });
}

function normalizeTitleLines(input, plan) {
  const fallback = plan.narrativeShape
    .replaceAll("_", " ")
    .toUpperCase();
  const values = Array.isArray(input) && input.length ? input : [fallback];
  if (values.length > 2) fail("Composition title has too many lines.");
  return Object.freeze(values.map((line, index) => safeText(
    line,
    `Composition title line ${index}`,
    { maximum: 48 },
  )));
}

function normalizePlan(ir, options = {}) {
  plainObject(ir, "AnimationIR");
  if (
    ir.schemaVersion !== SEMANTIC_SENTENCE_ANIMATION_SCHEMA_VERSION
    || ir.profile !== SEMANTIC_SENTENCE_ANIMATION_PROFILE
    || ir.profileVersion !== SEMANTIC_SENTENCE_ANIMATION_PROFILE_VERSION
    || ir.renderer?.provider !== SEMANTIC_SENTENCE_ANIMATION_PROVIDER
    || ir.renderer?.runtimeVersion !== SEMANTIC_SENTENCE_ANIMATION_RUNTIME_VERSION
    || ir.renderer?.styleVersion !== SEMANTIC_SENTENCE_ANIMATION_STYLE_VERSION
  ) {
    fail("Semantic sentence AnimationIR tuple is invalid.");
  }
  const width = integer(ir.width, "AnimationIR width", 9, 4320);
  const height = integer(ir.height, "AnimationIR height", 16, 7680);
  if (height * 9 !== width * 16) {
    fail("Semantic sentence animation requires a 9:16 AnimationIR.");
  }
  const fps = integer(ir.fps, "AnimationIR fps", 1, 120);
  const durationFrames = integer(
    ir.durationFrames,
    "AnimationIR duration",
    2,
    21600,
  );
  const content = plainObject(ir.content, "AnimationIR content");
  const semantic = plainObject(content.semantic, "AnimationIR semantic content");
  if (semantic.profileId !== SEMANTIC_SENTENCE_CONTENT_PROFILE_ID) {
    fail("Semantic sentence content profile is invalid.");
  }
  const sentencePlan = plainObject(
    content.semanticVisualSentencePlan,
    "Semantic visual sentence plan",
  );
  if (
    sentencePlan.schemaVersion !== 1
    || sentencePlan.profileId !== SEMANTIC_VISUAL_SENTENCE_PLAN_PROFILE_ID
  ) {
    fail("Semantic visual sentence plan profile is invalid.");
  }
  const suppliedSentencePlanHash = hash(
    sentencePlan.contentHash,
    "Sentence plan content hash",
  );
  if (contentHash(sentencePlan) !== suppliedSentencePlanHash) {
    fail("Semantic visual sentence plan hash does not match its content.");
  }
  const graphDeclaresPrimitivePayloads = Boolean(
    content.semanticEventGraph?.primitivePayloadProfileId !== undefined
    || content.semanticEventGraph?.propositions?.some(
      (proposition) => proposition?.primitivePayload !== undefined,
    )
  );
  const sourceSceneDslPlan = content.semanticAnimationSceneDslPlan;
  if (graphDeclaresPrimitivePayloads !== Boolean(sourceSceneDslPlan)) {
    fail(
      graphDeclaresPrimitivePayloads
        ? "Generalized semantic animation requires a Scene DSL plan."
        : "Checked semantic animation cannot declare a Scene DSL plan.",
    );
  }
  const planDeclaresPrimitiveParameters = (
    Array.isArray(sentencePlan.sentences)
    && sentencePlan.sentences.some(
      (sentence) => sentence?.primitiveParameters !== undefined,
    )
  );
  const sourceSentences = sentencePlan.sentences;
  const compositionProfileId = sentencePlan.sceneCompositionProfileId === undefined
    ? null
    : safeId(
      sentencePlan.sceneCompositionProfileId,
      "Semantic scene composition profile id",
    );
  const planDeclaresSceneCompositions = (
    Array.isArray(sourceSentences)
    && sourceSentences.some(
      (sentence) => sentence?.sceneComposition !== undefined,
    )
  );
  const everySentenceHasPrimitiveParameters = (
    Array.isArray(sourceSentences)
    && sourceSentences.length > 0
    && sourceSentences.every(
      (sentence) => sentence?.primitiveParameters !== undefined,
    )
  );
  const everySentenceHasSceneComposition = (
    Array.isArray(sourceSentences)
    && sourceSentences.length > 0
    && sourceSentences.every(
      (sentence) => sentence?.sceneComposition !== undefined,
    )
  );
  if (
    compositionProfileId !== null
    && compositionProfileId !== SEMANTIC_SCENE_COMPOSITION_PROFILE_ID
  ) {
    fail("Semantic scene composition profile is invalid.");
  }
  if (
    planDeclaresPrimitiveParameters !== planDeclaresSceneCompositions
    || everySentenceHasPrimitiveParameters !== everySentenceHasSceneComposition
  ) {
    fail("Semantic primitive parameters and scene compositions are inconsistent.");
  }
  if (
    compositionProfileId === null
      ? planDeclaresSceneCompositions
      : !everySentenceHasSceneComposition
  ) {
    fail("Semantic scene composition profile must cover every sentence.");
  }
  if (
    graphDeclaresPrimitivePayloads
      ? compositionProfileId === null || !everySentenceHasSceneComposition
      : compositionProfileId !== null || planDeclaresSceneCompositions
  ) {
    fail("Semantic scene composition profile does not match the embedded graph.");
  }
  const hasEmbeddedSemanticGraph = content.semanticEventGraph !== undefined;
  const requireGraphlessCheckedProfile =
    !hasEmbeddedSemanticGraph && !planDeclaresPrimitiveParameters;
  if (hasEmbeddedSemanticGraph) {
    if (graphDeclaresPrimitivePayloads) {
      if (options.semanticSourceContext) {
        try {
          validateSemanticEventGraphAgainstDraft(
            content.semanticEventGraph,
            options.semanticSourceContext,
          );
        } catch {
          fail(
            "Generalized semantic source bindings do not match the trusted context.",
          );
        }
      } else {
        fail(
          "Generalized semantic source bindings require trusted validation context.",
        );
      }
    }
    if (
      !graphDeclaresPrimitivePayloads
      && !planDeclaresPrimitiveParameters
      && !CHECKED_UNPARAMETERIZED_SEMANTIC_EVENT_GRAPH_HASHES.includes(
        content.semanticEventGraph?.contentHash,
      )
    ) {
      fail("Unparameterized semantic graph is not an approved checked profile.");
    }
    if (
      !graphDeclaresPrimitivePayloads
      && !planDeclaresPrimitiveParameters
      && !CHECKED_UNPARAMETERIZED_SEMANTIC_SENTENCE_PLAN_HASHES.includes(
        suppliedSentencePlanHash,
      )
    ) {
      fail(
        "Unparameterized semantic sentence plan is not an approved checked profile.",
      );
    }
    try {
      validateSemanticVisualSentencePlanAgainstGraph(
        sentencePlan,
        content.semanticEventGraph,
      );
    } catch {
      fail("Semantic primitive parameters are not bound to the embedded graph.");
    }
  } else if (planDeclaresPrimitiveParameters) {
    fail("Semantic primitive parameters require an embedded semantic graph.");
  }
  let sceneDslPlan = null;
  if (sourceSceneDslPlan) {
    const suppliedSceneDslPlanHash = hash(
      sourceSceneDslPlan.contentHash,
      "Scene DSL plan content hash",
    );
    if (
      semantic.semanticAnimationSceneDslPlanHash
        !== suppliedSceneDslPlanHash
    ) {
      fail("Scene DSL plan hash does not match semantic content.");
    }
    try {
      sceneDslPlan = validateSemanticAnimationSceneDslPlanAgainstContext(
        sourceSceneDslPlan,
        {
          semanticEventGraph: content.semanticEventGraph,
          semanticVisualSentencePlan: sentencePlan,
        },
      );
    } catch {
      fail("Scene DSL plan is not grounded in the semantic sentence plan.");
    }
  }
  const bindings = plainObject(
    sentencePlan.bindings,
    "Semantic visual sentence plan bindings",
  );
  const normalizedBindings = Object.freeze({
    semanticEventGraphHash: hash(
      bindings.semanticEventGraphHash,
      "Semantic event graph hash",
    ),
    draftHash: hash(bindings.draftHash, "Sentence plan draft hash"),
    sourceStoryboardHash: hash(
      bindings.sourceStoryboardHash,
      "Sentence plan storyboard hash",
    ),
    timingContextHash: hash(
      bindings.timingContextHash,
      "Sentence plan timing hash",
    ),
  });
  if (ir.draftHash !== undefined && ir.draftHash !== normalizedBindings.draftHash) {
    fail("Semantic sentence plan is bound to a different draft.");
  }
  if (
    ir.timingBinding?.timingContextHash !== undefined
    && ir.timingBinding.timingContextHash !== normalizedBindings.timingContextHash
  ) {
    fail("Semantic sentence plan is bound to different narration timing.");
  }
  if (!Array.isArray(sourceSentences) || !sourceSentences.length || sourceSentences.length > 96) {
    fail("Semantic visual sentence plan requires bounded sentences.");
  }
  const sentences = sourceSentences.map(
    (sentence, index) => normalizeSentence(sentence, index, durationFrames),
  );
  if (
    requireGraphlessCheckedProfile
    && (
      !CHECKED_UNPARAMETERIZED_SEMANTIC_EVENT_GRAPH_HASHES.includes(
        normalizedBindings.semanticEventGraphHash,
      )
      || !CHECKED_UNPARAMETERIZED_SEMANTIC_SENTENCE_PLAN_HASHES.includes(
        suppliedSentencePlanHash,
      )
    )
  ) {
    fail("Graphless sentence plan is not an approved checked profile.");
  }
  const ids = new Set();
  let previousStart = -1;
  let previousEnd = 0;
  for (const [index, sentence] of sentences.entries()) {
    if (ids.has(sentence.id)) fail("Semantic sentence ids must be unique.");
    ids.add(sentence.id);
    if (
      sentence.wordSpan.startFrame <= previousStart
      || sentence.wordSpan.startFrame < previousEnd
    ) {
      fail(`Sentence ${index} timing overlaps or is out of order.`);
    }
    previousStart = sentence.wordSpan.startFrame;
    previousEnd = sentence.wordSpan.endFrame;
  }
  const normalizedSentencePlan = Object.freeze({
    profileId: sentencePlan.profileId,
    contentHash: suppliedSentencePlanHash,
    storyFormat: safeId(sentencePlan.storyFormat, "Story format"),
    narrativeShape: safeId(sentencePlan.narrativeShape, "Narrative shape"),
    bindings: normalizedBindings,
    sentences: Object.freeze(sentences),
    ...(compositionProfileId
      ? { sceneCompositionProfileId: compositionProfileId }
      : {}),
  });
  const intervals = semanticSentenceRenderIntervals(
    sentences,
    durationFrames,
  );
  const sceneActionSchedule = sceneDslPlan
    ? compileSemanticSceneActionSchedule({
      sceneDslPlan,
      sentences,
      intervals,
      fps,
      durationFrames,
    })
    : null;
  return Object.freeze({
    compositionId: safeId(content.compositionId, "Composition id"),
    width,
    height,
    fps,
    durationFrames,
    kicker: safeText(content.kicker || "DARK CURIOSITY", "Composition kicker", {
      maximum: 32,
    }),
    titleLines: normalizeTitleLines(content.titleLines, normalizedSentencePlan),
    animationIRHash: ir.contentHash === undefined
      ? ""
      : hash(ir.contentHash, "AnimationIR content hash"),
    sentencePlan: normalizedSentencePlan,
    intervals,
    ...(sceneDslPlan ? { sceneDslPlan, sceneActionSchedule } : {}),
  });
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function semanticSentenceRenderIntervals(sentences, durationFrames) {
  if (!Array.isArray(sentences) || !sentences.length || sentences.length > 96) {
    fail("Semantic sentence intervals require a bounded sentence list.");
  }
  integer(durationFrames, "Semantic sentence duration", 2, 21600);
  return Object.freeze(sentences.map((sentence, index) => {
    const startFrame = integer(
      sentence.wordSpan?.startFrame,
      `Sentence ${index} interval start`,
      0,
      durationFrames - 1,
    );
    const semanticEndFrame = integer(
      sentence.wordSpan?.endFrame,
      `Sentence ${index} semantic end`,
      startFrame + 1,
      durationFrames,
    );
    const endFrame = index + 1 < sentences.length
      ? integer(
        sentences[index + 1].wordSpan?.startFrame,
        `Sentence ${index} interval end`,
        semanticEndFrame,
        durationFrames - 1,
      )
      : durationFrames;
    if (endFrame <= startFrame) fail(`Sentence ${index} interval is empty.`);
    return Object.freeze({
      sentenceId: safeId(sentence.id, `Sentence ${index} interval id`),
      startFrame,
      semanticEndFrame,
      endFrame,
    });
  }));
}

export function semanticSimpleExplainerVisualGroups(
  sentences,
  intervals,
  durationFrames,
  fps = 30,
) {
  if (
    !Array.isArray(sentences)
    || !Array.isArray(intervals)
    || sentences.length !== intervals.length
    || !sentences.length
  ) fail("Simple-explainer visual groups require matching sentences and intervals.");
  integer(durationFrames, "Simple-explainer duration", 2, 21600);
  integer(fps, "Simple-explainer fps", 1, 120);
  const groups = buildSemanticSimpleExplainerGroups(sentences, { fps });
  return Object.freeze(groups.map((group) => {
    const first = intervals[group.firstSentenceIndex];
    const last = intervals[group.lastSentenceIndex];
    const anchor = sentences[group.anchorSentenceIndex];
    if (
      !first
      || !last
      || !anchor
      || first.startFrame < 0
      || last.semanticEndFrame <= first.startFrame
      || last.endFrame < last.semanticEndFrame
      || last.endFrame > durationFrames
    ) fail("Simple-explainer visual group timing is invalid.");
    const stepStartFrames = Object.freeze(group.sentenceIndices.map(
      (sentenceIndex) => intervals[sentenceIndex].startFrame,
    ));
    const presentationTiming = semanticSimpleExplainerPresentationTiming({
      fps,
      startFrame: first.startFrame,
      semanticEndFrame: last.semanticEndFrame,
      endFrame: last.endFrame,
      stepStartFrames,
    });
    return Object.freeze({
      ...group,
      stageId: `semantic-sentence-${group.anchorSentenceIndex}`,
      startFrame: first.startFrame,
      semanticEndFrame: last.semanticEndFrame,
      endFrame: last.endFrame,
      stepStartFrames,
      presentationTiming,
      sceneCompositionId: anchor.sceneComposition?.id || null,
      sceneCompositionLayoutId: anchor.sceneComposition?.layoutId || null,
      sceneCompositionProfileId: anchor.sceneComposition?.profileId || null,
    });
  }));
}

export function activeSemanticSentenceIndexAtFrame(sentences, frame) {
  if (!Array.isArray(sentences) || !sentences.length) {
    fail("Active sentence lookup requires sentences.");
  }
  if (!Number.isFinite(frame)) fail("Active sentence frame is invalid.");
  let selected = 0;
  for (const [index, sentence] of sentences.entries()) {
    const startFrame = sentence.startFrame ?? sentence.wordSpan?.startFrame;
    if (!Number.isInteger(startFrame) || startFrame < 0) {
      fail(`Sentence ${index} start frame is invalid.`);
    }
    if (frame >= startFrame) selected = index;
    else break;
  }
  return selected;
}

export function compileSemanticSentenceAnimationIRToHtml(ir, options = {}) {
  const plan = normalizePlan(ir, options);
  const compositionId = escapeSemanticSentenceXml(plan.compositionId);
  const usesSceneComposition = Boolean(
    plan.sentencePlan.sceneCompositionProfileId,
  );
  const usesSceneActions = Boolean(plan.sceneActionSchedule);
  const titleMarkup = plan.titleLines.map((line, index) => (
    `<text x="54" y="${98 + index * 38}" class="composition-title">${
      escapeSemanticSentenceXml(line)
    }</text>`
  )).join("");
  const visualGroups = usesSceneComposition
    ? semanticSimpleExplainerVisualGroups(
      plan.sentencePlan.sentences,
      plan.intervals,
      plan.durationFrames,
      plan.fps,
    )
    : Object.freeze(plan.intervals.map((interval, index) => Object.freeze({
      id: `sentence_scene_${plan.sentencePlan.sentences[index].id}`,
      profileId: null,
      beatId: plan.sentencePlan.sentences[index].beatId,
      groupIndex: index,
      sentenceIndices: Object.freeze([index]),
      sentenceIds: Object.freeze([plan.sentencePlan.sentences[index].id]),
      firstSentenceIndex: index,
      lastSentenceIndex: index,
      anchorSentenceIndex: index,
      anchorSentenceId: plan.sentencePlan.sentences[index].id,
      stageId: `semantic-sentence-${index}`,
      startFrame: interval.startFrame,
      semanticEndFrame: interval.semanticEndFrame,
      endFrame: interval.endFrame,
      sceneCompositionId: null,
      sceneCompositionLayoutId: null,
      sceneCompositionProfileId: null,
    })));
  const presentedSceneActionSchedule = usesSceneActions
    ? (
      usesSceneComposition
        ? compileSemanticSimpleExplainerGroupActionSchedule({
          sceneDslPlan: plan.sceneDslPlan,
          sentences: plan.sentencePlan.sentences,
          visualGroups,
          fps: plan.fps,
          durationFrames: plan.durationFrames,
        })
        : plan.sceneActionSchedule
    )
    : null;
  const runtimeVisualGroups = (
    usesSceneComposition && presentedSceneActionSchedule
  )
    ? Object.freeze(visualGroups.map((group, index) => Object.freeze({
      ...group,
      sceneActionSchedule: presentedSceneActionSchedule.scenes[index],
    })))
    : visualGroups;
  const sentenceMarkup = visualGroups.map((group) => {
    const groupSentences = group.sentenceIndices.map(
      (index) => plan.sentencePlan.sentences[index],
    );
    const groupText = groupSentences.map(
      (sentence) => sentence.wordSpan.text,
    ).join(" ");
    return semanticSentencePrimitiveMarkup(
      plan.sentencePlan.sentences[group.anchorSentenceIndex],
      group.anchorSentenceIndex,
      usesSceneComposition
        ? {
          simpleExplainerContext: {
            profileId: SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID,
            visualKind: group.visualKind,
            groupText,
            stepCount: groupSentences.length,
            visualConceptIds: groupSentences.map(
              (sentence) => sentence.primitiveParameters.visualConceptId,
            ),
            stepHeadings: groupSentences.map((sentence) => (
              semanticSimpleExplainerHeading(
                sentence.primitiveParameters,
                groupText,
                120,
              )
            )),
          },
        }
        : {},
    );
  }).join("\n");
  const sceneCompositionCss = usesSceneComposition ? `
.composition[data-scene-composition-profile-id] .composition-kicker{display:none}
.composition[data-scene-composition-profile-id] .composition-title{font-size:34px}
.sentence-concept-label{fill:#a5f3fc;font-size:28px;letter-spacing:1.3px}
.semantic-nonvisual-topology{opacity:0}
.semantic-support-module{transform-box:fill-box;transform-origin:center}
.semantic-bounded-edge{stroke-width:3.25}
.composition[data-scene-composition-profile-id] text[id^="semantic-evidence-"][data-legibility-role="key"]{fill:#f8fafc;font-size:34px;font-weight:600}
.composition[data-scene-composition-profile-id] text[id^="semantic-evidence-"][data-legibility-role="secondary"]{fill:#f8fafc;font-size:26px}
.composition[data-scene-composition-profile-id] [data-evidence-variant="document"] text[id^="semantic-evidence-"][data-legibility-role="secondary"]{fill:#0f172a}` : "";
  const sceneActionCss = usesSceneActions ? `
.semantic-scene-camera-channel{transform-box:view-box;transform-origin:360px 520px}
.semantic-primary-module,.semantic-support-module{transform-box:fill-box;transform-origin:center}` : "";
  const sceneCompositionProfileAttribute = usesSceneComposition
    ? `\n data-scene-composition-profile-id="${
      escapeSemanticSentenceXml(plan.sentencePlan.sceneCompositionProfileId)
    }"
 data-semantic-presentation-profile-id="${SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID}"`
    : "";
  const sceneActionProfileAttributes = usesSceneActions
    ? `
 data-semantic-scene-dsl-plan-hash="${
      escapeSemanticSentenceXml(plan.sceneDslPlan.contentHash)
    }"
 data-semantic-scene-action-schedule-hash="${
      escapeSemanticSentenceXml(presentedSceneActionSchedule.contentHash)
    }"`
    : "";
  const sceneCompositionRevealRuntime = (
    usesSceneComposition && !usesSceneActions
  ) ? `
 const sceneComposition=stage.querySelector(".semantic-scene-composition");
 sceneComposition.querySelectorAll(".semantic-support-module[data-scene-module-id]").forEach((element)=>{
  const order=Number(element.dataset.revealOrder)||1;
  const local=ease((revealProgress-(.05+order*.10))/.30);
  setOpacity(element,local);
  element.setAttribute("transform","translate(0 "+(12*(1-local)).toFixed(3)+") scale("+(.96+.04*local).toFixed(4)+")");
 });
 sceneComposition.querySelectorAll(".semantic-composition-link").forEach((element,index)=>{
  setOpacity(element,ease((revealProgress-(.12+index*.08))/.26));
 });` : "";
  const boundedGeometryRuntime = usesSceneComposition ? `
 stage.querySelectorAll(".semantic-bounded-edge[data-blueprint-reveal-order]").forEach((element)=>{
  const order=Number(element.dataset.blueprintRevealOrder)||0;
  setOpacity(element,ease((revealProgress-(.06+order*.035))/.38));
 });
 stage.querySelectorAll(".semantic-bounded-node[data-blueprint-reveal-order]").forEach((element)=>{
  const order=Number(element.dataset.blueprintRevealOrder)||0;
  const local=ease((revealProgress-(.14+order*.045))/.34);
  setOpacity(element,local);
  element.setAttribute("transform","translate(0 "+(10*(1-local)).toFixed(3)+")");
 });` : "";
  const cameraTransformRuntime = usesSceneComposition
    ? ` cameraChannel.style.transform="none";`
    : ` cameraChannel.style.transform="scale("+sceneActionState.cameraScale.toFixed(5)+")";`;
  const actionScheduleExpression = usesSceneComposition
    ? "visual.sceneActionSchedule"
    : "active.sceneActionSchedule";
  const stageTransformRuntime = usesSceneActions ? `
 const sceneActionState=semanticSceneActionStateAtFrame(${actionScheduleExpression},frame);
 const simpleCreateAction=${usesSceneComposition
    ? 'visual.sceneActionSchedule.actions.length===1&&visual.sceneActionSchedule.actions[0].op==="create"'
    : "false"};
 stage.setAttribute("transform","translate(0 0) scale(1)");
 const cameraChannels=stage.querySelectorAll(".semantic-scene-camera-channel");
 if(cameraChannels.length!==1)throw new Error("invalid_scene_camera_channel_count");
 const cameraChannel=cameraChannels[0];
${cameraTransformRuntime}
 const hasVisibleRouteMarker=Boolean(
  stage.querySelector(".semantic-route-path")
  &&stage.querySelector(".semantic-route-marker"),
 );
 sceneActionState.modules.forEach((moduleState)=>{
  const elements=stage.querySelectorAll('[data-scene-module-id="'+moduleState.id+'"]');
  if(elements.length!==1)throw new Error("invalid_scene_action_target_count");
  const element=elements[0];
  const routeShift=moduleState.id==="module_primary"
   &&!hasVisibleRouteMarker
   &&sceneActionState.routeDisplacement!==null
   ?sceneActionState.routeDisplacement
   :{x:0,y:0};
  const translateX=(simpleCreateAction?0:moduleState.translateX)+routeShift.x;
  const translateY=(simpleCreateAction?0:moduleState.translateY)+routeShift.y;
  const presentedScale=simpleCreateAction?1:moduleState.scale;
  const presentedOpacity=moduleState.id==="module_primary"
   ?${usesSceneComposition ? "revealProgress" : "Math.min(revealProgress,moduleState.opacity)"}
   :moduleState.opacity;
  setOpacity(element,presentedOpacity);
  element.style.transform="translate("+translateX.toFixed(3)+"px,"+translateY.toFixed(3)+"px) scale("+presentedScale.toFixed(5)+")";
  element.style.filter="none";
  element.dataset.sceneActionOpacity=presentedOpacity.toFixed(4);
  element.dataset.sceneActionScale=presentedScale.toFixed(4);
  element.dataset.sceneActionGlow=moduleState.glow.toFixed(4);
  element.dataset.sceneActionTranslateX=translateX.toFixed(4);
  element.dataset.sceneActionTranslateY=translateY.toFixed(4);
 });
 const moduleStateById=Object.fromEntries(
  sceneActionState.modules.map((moduleState)=>[moduleState.id,moduleState]),
 );
 const sceneLinks=stage.querySelectorAll(".semantic-composition-link");
 if(sceneLinks.length!==2)throw new Error("invalid_scene_link_count");
 sceneLinks.forEach((element)=>{
  const fromState=moduleStateById[element.dataset.fromModuleId];
  const toState=moduleStateById[element.dataset.toModuleId];
  if(!fromState||!toState)throw new Error("missing_scene_link_target");
  setOpacity(element,Math.min(fromState.opacity,toState.opacity));
 });
 stage.dataset.sceneDslId=${actionScheduleExpression}.sceneDslId;
 stage.dataset.activeSceneActionIds=sceneActionState.activeActionIds.join(",");
 stage.dataset.activeSceneActionSignatures=sceneActionState.activeActionSignatures.join(",");
 stage.dataset.activeSceneActionProgress=sceneActionState.actionStates
  .filter((action)=>action.active)
  .map((action)=>action.id+"="+action.progress.toFixed(4))
  .join(",");` : ` stage.setAttribute("transform","translate(0 "+(16*(1-revealProgress)).toFixed(3)+") scale("+(.98+.02*revealProgress).toFixed(5)+")");`;
  const routeProgressSetupRuntime = usesSceneActions ? `
  const routeActionProgress=sceneActionState.routeProgress===null
   ?${usesSceneComposition ? "1" : "semanticProgress"}
   :sceneActionState.routeProgress;
  const routeRevealProgress=sceneActionState.routeProgress===null
   ?${usesSceneComposition ? "revealProgress" : "semanticProgress"}
   :sceneActionState.routeProgress;` : "";
  const routeProgressExpression = usesSceneComposition
    ? "revealProgress"
    : (usesSceneActions ? "routeRevealProgress" : "semanticProgress");
  const routePointRuntime = usesSceneActions ? `
  const point=sceneActionState.routePoint!==null
   ?sceneActionState.routePoint
   :(typeof route.getPointAtLength==="function"
    ?route.getPointAtLength(length*routeActionProgress)
    :{x:118,y:566});` : `
  const point=typeof route.getPointAtLength==="function"
   ?route.getPointAtLength(length*semanticProgress)
   :{x:118+484*semanticProgress,y:566-222*semanticProgress};`;
  const counterTransitionExpression = usesSceneActions
    ? "(sceneActionState.semanticTransitionProgress===null?ease((semanticProgress-.34)/.34):sceneActionState.semanticTransitionProgress)"
    : "ease((semanticProgress-.34)/.34)";
  const vesselTransitionExpression = usesSceneActions
    ? "(sceneActionState.semanticTransitionProgress===null?ease((semanticProgress-.28)/.52):sceneActionState.semanticTransitionProgress)"
    : "ease((semanticProgress-.28)/.52)";
  const transitionRotationExpression = usesSceneActions
    ? "(sceneActionState.semanticTransitionProgress===null?semanticProgress:sceneActionState.semanticTransitionProgress)"
    : "semanticProgress";
  const sceneCompositionDatasetRuntime = usesSceneComposition ? `
 document.documentElement.dataset.activeSceneCompositionId=visual.sceneCompositionId;
 document.documentElement.dataset.activeSceneCompositionLayoutId=visual.sceneCompositionLayoutId;
 document.documentElement.dataset.activeSceneCompositionProfileId=visual.sceneCompositionProfileId;
 document.documentElement.dataset.activeVisualBeatId=visual.beatId;
 document.documentElement.dataset.activeVisualAnchorSentenceId=visual.anchorSentenceId;` : "";
  const sceneActionDatasetRuntime = usesSceneActions ? `
 document.documentElement.dataset.activeSceneDslId=${actionScheduleExpression}.sceneDslId;
 document.documentElement.dataset.activeSceneActionIds=sceneActionState.activeActionIds.join(",");
 document.documentElement.dataset.activeSceneActionSignatures=sceneActionState.activeActionSignatures.join(",");
 document.documentElement.dataset.semanticSceneDslPlanHash=DATA.sceneDslPlanHash;
 document.documentElement.dataset.semanticSceneActionScheduleHash=DATA.sceneActionScheduleHash;` : "";
  const simplePresentationRuntime = usesSceneComposition ? `
 const header=document.getElementById("semantic-sentence-header");
 setOpacity(header,0);
 document.documentElement.dataset.semanticPresentationProfileId=DATA.presentationProfileId;
 document.documentElement.dataset.activeVisualSceneId=visual.id;` : "";
  const stageCollectionRuntime = usesSceneComposition
    ? `const stages=DATA.visualGroups.map((visual)=>document.getElementById(visual.stageId));
const activeIndexAt=(frame)=>{let selected=0;for(let index=0;index<DATA.intervals.length;index+=1){if(frame>=DATA.intervals[index].startFrame)selected=index;else break}return selected};
const activeVisualIndexAt=(frame)=>{let selected=0;for(let index=0;index<DATA.visualGroups.length;index+=1){if(frame>=DATA.visualGroups[index].startFrame)selected=index;else break}return selected};`
    : `const stages=DATA.intervals.map((_,index)=>document.getElementById("semantic-sentence-"+index));
const activeIndexAt=(frame)=>{let selected=0;for(let index=0;index<DATA.intervals.length;index+=1){if(frame>=DATA.intervals[index].startFrame)selected=index;else break}return selected};`;
  const stageResetRuntime = usesSceneComposition ? `
const initialStageAttributeState=stages.map((stage)=>
 [stage,...stage.querySelectorAll("*")].map((element)=>({
  element,
  attributes:[...element.attributes].map((attribute)=>[
   attribute.name,
   attribute.value,
  ]),
 })),
);
let lastRenderedStageIndex=null;
const restoreInitialStageState=(index)=>{
 const entries=initialStageAttributeState[index];
 if(!entries)throw new Error("invalid_semantic_stage_reset_index");
 entries.forEach(({element,attributes})=>{
  const initialNames=new Set(attributes.map(([name])=>name));
  [...element.attributes].forEach((attribute)=>{
   if(!initialNames.has(attribute.name))element.removeAttribute(attribute.name);
  });
  attributes.forEach(([name,value])=>element.setAttribute(name,value));
 });
};` : "";
  const stageResetAtFrameRuntime = usesSceneComposition ? `
 if(lastRenderedStageIndex!==null&&lastRenderedStageIndex!==visualIndex){
  restoreInitialStageState(lastRenderedStageIndex);
 }
 restoreInitialStageState(visualIndex);
 lastRenderedStageIndex=visualIndex;` : "";
  const simpleAutoLayoutRuntime = usesSceneComposition ? `
const SIMPLE_LAYOUT_PROFILES=Object.freeze({
 absence:{width:500,height:360,maxScale:1.12},
 bounded_structure:{width:540,height:320,maxScale:1.14},
 cause_effect:{width:500,height:360,maxScale:1.14},
 comparison:{width:540,height:360,maxScale:1.08},
 cycle:{width:500,height:360,maxScale:1.10},
 evidence:{width:480,height:360,maxScale:1.08},
 rejection:{width:500,height:360,maxScale:1.10},
 route:{width:540,height:360,maxScale:1.05},
 state_change:{width:500,height:340,maxScale:1.14},
 timeline:{width:540,height:320,maxScale:1.10},
 uncertainty:{width:500,height:360,maxScale:1.10},
});
const layoutSemanticSimpleStage=(stage,visualKind)=>{
 const layoutFrame=stage.querySelector('[data-semantic-auto-layout="focus"]');
 const focus=layoutFrame?.querySelector(".semantic-geometry");
 const profile=SIMPLE_LAYOUT_PROFILES[visualKind];
 if(!layoutFrame||!focus||!profile||typeof focus.getBBox!=="function"){
  throw new Error("invalid_semantic_focus_layout");
 }
 layoutFrame.removeAttribute("transform");
 const bounds=focus.getBBox();
 if(
  !Number.isFinite(bounds.x)||!Number.isFinite(bounds.y)
  ||!Number.isFinite(bounds.width)||!Number.isFinite(bounds.height)
  ||bounds.width<1||bounds.height<1
 )throw new Error("invalid_semantic_focus_bounds");
 const scale=clamp(
  Math.min(profile.width/bounds.width,profile.height/bounds.height),
  .82,
  profile.maxScale,
 );
 const centerX=bounds.x+bounds.width/2;
 const centerY=bounds.y+bounds.height/2;
 layoutFrame.setAttribute(
  "transform",
  "translate(360 490) scale("+scale.toFixed(5)+") translate("
   +(-centerX).toFixed(3)+" "+(-centerY).toFixed(3)+")",
 );
 layoutFrame.dataset.semanticLayoutScale=scale.toFixed(5);
 layoutFrame.dataset.semanticLayoutCenterX=centerX.toFixed(3);
 layoutFrame.dataset.semanticLayoutCenterY=centerY.toFixed(3);
 layoutFrame.dataset.semanticLayoutVisualKind=visualKind;
};` : "";
  const simpleAutoLayoutAtFrameRuntime = usesSceneComposition ? `
 layoutSemanticSimpleStage(stage,visual.visualKind);
 const atmosphere=stage.querySelector(".semantic-scene-atmosphere");
 if(!atmosphere)throw new Error("missing_semantic_scene_atmosphere");
 setOpacity(atmosphere,.72+.28*revealProgress);` : "";
  const stageVisibilityRuntime = usesSceneComposition
    ? '\n  element.style.visibility=visible?"visible":"hidden";'
    : "";
  const stageSelectionRuntime = usesSceneComposition
    ? ` const activeIndex=activeIndexAt(frame),active=DATA.intervals[activeIndex];
 const visualIndex=activeVisualIndexAt(frame),visual=DATA.visualGroups[visualIndex],stage=stages[visualIndex];
 const visualProgress=clamp((frame-visual.startFrame)/Math.max(1,visual.endFrame-visual.startFrame-1));
 const semanticProgress=ease(visualProgress);
 const revealProgress=revealEase((frame-visual.startFrame)/visual.presentationTiming.revealDurationFrames);`
    : ` const activeIndex=activeIndexAt(frame),active=DATA.intervals[activeIndex],stage=stages[activeIndex];
 const semanticProgress=ease((frame-active.startFrame)/Math.max(1,active.semanticEndFrame-active.startFrame-1));
 const revealProgress=ease((frame-active.startFrame)/Math.min(10,Math.max(1,active.semanticEndFrame-active.startFrame-1)));`;
  const runtimeData = safeJson({
    compositionId: plan.compositionId,
    fps: plan.fps,
    durationFrames: plan.durationFrames,
    planHash: plan.sentencePlan.contentHash,
    ...(usesSceneComposition ? {
      presentationProfileId: SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID,
      visualGroups: runtimeVisualGroups,
    } : {}),
    ...(usesSceneActions ? {
      sceneDslPlanHash: plan.sceneDslPlan.contentHash,
      sceneActionScheduleHash: presentedSceneActionSchedule.contentHash,
    } : {}),
    intervals: plan.intervals.map((interval, index) => ({
      ...interval,
      propositionId: plan.sentencePlan.sentences[index].propositionId,
      focusEntityId: plan.sentencePlan.sentences[index].focusEntity.id,
      assetId: plan.sentencePlan.sentences[index].capability.assetId,
      grammarId: plan.sentencePlan.sentences[index].capability.grammarId,
      capability: plan.sentencePlan.sentences[index].visualIntent,
      geometryKind: plan.sentencePlan.sentences[index].geometryKind,
      claimIds: plan.sentencePlan.sentences[index].claimIds,
      ...(plan.sentencePlan.sentences[index].sceneComposition ? {
        sceneCompositionId:
          plan.sentencePlan.sentences[index].sceneComposition.id,
        sceneCompositionLayoutId:
          plan.sentencePlan.sentences[index].sceneComposition.layoutId,
        sceneCompositionProfileId:
          plan.sentencePlan.sentences[index].sceneComposition.profileId,
      } : {}),
      ...(usesSceneActions && !usesSceneComposition ? {
        sceneActionSchedule: plan.sceneActionSchedule.scenes[index],
      } : {}),
    })),
  });
  const durationSeconds = plan.durationFrames / plan.fps;
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; media-src 'none'; font-src data:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
<meta data-composition-id="${compositionId}" data-width="${plan.width}" data-height="${plan.height}"
 data-font-sha256="${FONT_SHA256}" data-semantic-sentence-plan-hash="${plan.sentencePlan.contentHash}"${sceneActionProfileAttributes}>
<style>
@font-face{font-family:"${FONT_FAMILY}";src:url(data:font/woff2;base64,${FONT_BASE64}) format("woff2");font-style:normal;font-weight:600;font-display:block}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#02050c}
*{box-sizing:border-box}.composition{width:100vw;height:100vh;overflow:hidden;background:#02050c}
.composition svg{display:block;width:100%;height:100%;font-family:"${FONT_FAMILY}",sans-serif}
.semantic-sentence-stage{transform-box:view-box;transform-origin:360px 520px}
.sentence-surface{fill:#0a1728;stroke:#334155;stroke-width:2.5}.cool-panel{fill:#083344;stroke:#22d3ee;stroke-width:2.5}
.warm-panel{fill:#422006;stroke:#f59e0b;stroke-width:2.5}.reject-panel{fill:#3f1524;stroke:#fb7185;stroke-width:3}
.cool-line{fill:none;stroke:#22d3ee;stroke-width:6;stroke-linecap:round;stroke-linejoin:round}
.warm-line{fill:none;stroke:#f59e0b;stroke-width:6;stroke-linecap:round;stroke-linejoin:round}
.bright-line{fill:none;stroke:#f8fafc;stroke-width:5;stroke-linecap:round}
.muted-line{fill:none;stroke:#475569;stroke-width:2.5}.connector-line{fill:none;stroke:#67e8f9;stroke-width:5;stroke-linecap:round;stroke-linejoin:round}
.warm-fill{fill:#f59e0b}.cool-fill{fill:#22d3ee}.bright-fill{fill:#f8fafc}
.cool-halo{fill:#22d3ee;fill-opacity:.12;stroke:#22d3ee;stroke-width:3}.warm-halo{fill:#f59e0b;fill-opacity:.12;stroke:#f59e0b;stroke-width:3}
.reject-halo{fill:#fb7185;fill-opacity:.13;stroke:#fb7185;stroke-width:3}.error-cross{fill:none;stroke:#fb7185;stroke-width:8;stroke-linecap:round}
.sentence-capability-label{fill:#67e8f9;font-size:17px;letter-spacing:2.4px}.sentence-copy{fill:#f8fafc;font-size:24px}
.sentence-copy[data-legibility-role="key"]{font-size:32px}.sentence-copy[data-legibility-role="secondary"]{font-size:24px}
.micro-copy{fill:#cbd5e1;font-size:26px;letter-spacing:1.1px}.composition-kicker{fill:#67e8f9;font-size:17px;letter-spacing:4px}
.composition-title{fill:#e2e8f0;font-size:30px}.large-value{fill:#fde68a;font-size:48px}.counter-value{fill:#f8fafc;font-size:76px}
.warm-copy{fill:#fde68a}.counter-cycle{fill:none;stroke:#22d3ee;stroke-width:9;stroke-linecap:round}
.counter-tick{stroke:#475569;stroke-width:5;stroke-linecap:round}.pointer-line{stroke-width:8}.calendar-cell{fill:#164e63;stroke:#22d3ee;stroke-width:1.5}
.mapping-grid{opacity:.72}.comparison-glyph{fill:#fde68a;font-size:28px}.semantic-divider{stroke:#334155;stroke-width:2;stroke-dasharray:8 10}
.ice-line{fill:none;stroke:#a5f3fc;stroke-width:7;stroke-linejoin:round}.secondary-ice{stroke:#155e75;stroke-width:5}
.vessel-hull{fill:#164e63;stroke:#67e8f9;stroke-width:5}.vessel-structure{fill:none;stroke:#67e8f9;stroke-width:7;stroke-linejoin:round}
.vessel-window{fill:#fbbf24}.absence-outline{fill:none;stroke:#fb7185;stroke-width:5;stroke-dasharray:14 12}
.absence-mark{fill:#fecdd3;font-size:34px;letter-spacing:4px}.blizzard-line{fill:none;stroke:#e0f2fe;stroke-width:7;stroke-linecap:round;opacity:.8}
.map-surface{fill:#061827;stroke:#155e75;stroke-width:3}.coast-line{fill:none;stroke:#0e7490;stroke-width:7}.secondary-coast{stroke:#164e63}
.map-grid-line{fill:none;stroke:#155e75;stroke-width:1;opacity:.5}.semantic-route-guide{fill:none;stroke:#0e7490;stroke-width:3;stroke-linecap:round}
.semantic-route-path{fill:none;stroke:#fbbf24;stroke-width:7;stroke-linecap:round;stroke-dasharray:12 11}
.route-vessel{fill:#164e63;stroke:#ecfeff;stroke-width:4}.route-vessel-detail{fill:none;stroke:#ecfeff;stroke-width:4}
.chronology-axis{fill:none;stroke:#22d3ee;stroke-width:7;stroke-linecap:round}.chronology-tick{stroke:#64748b;stroke-width:3}
.timeline-label{fill:#cbd5e1;font-size:19px}.paper-surface{fill:#dbeafe;stroke:#93c5fd;stroke-width:3}
.paper-heading{fill:#0e7490}.record-line{fill:none;stroke:#64748b;stroke-width:4}.evidence-highlight{fill:#f59e0b;fill-opacity:.18;stroke:#f59e0b;stroke-width:3}
.magnifier-lens{fill:#083344;fill-opacity:.34;stroke:#67e8f9;stroke-width:8}.magnifier-handle{fill:none;stroke:#67e8f9;stroke-width:18;stroke-linecap:round}
.semantic-uncertainty-boundary{fill:#082f49;fill-opacity:.24;stroke:#fbbf24;stroke-width:7;stroke-dasharray:18 14}
.uncertainty-core{fill:#0f172a;stroke:#475569;stroke-width:4}.uncertainty-glyph{fill:#fde68a;font-size:132px}
.uncertainty-particles{fill:#67e8f9}.caption-scrim{fill:url(#sentence-caption-scrim)}${sceneCompositionCss}${sceneActionCss}
</style></head><body>
<main id="animation-root" class="composition" data-composition-id="${compositionId}"
 data-start="0" data-duration="${durationSeconds}" data-width="${plan.width}" data-height="${plan.height}"
 data-semantic-profile-id="${SEMANTIC_SENTENCE_CONTENT_PROFILE_ID}"
 data-semantic-sentence-plan-hash="${plan.sentencePlan.contentHash}"
 data-semantic-event-graph-hash="${plan.sentencePlan.bindings.semanticEventGraphHash}"${sceneCompositionProfileAttribute}${sceneActionProfileAttributes}>
<svg viewBox="0 0 ${BASE_WIDTH} ${BASE_HEIGHT}" role="img"
 aria-label="${escapeSemanticSentenceXml(plan.titleLines.join(" "))}">
<defs>
 <radialGradient id="sentence-bg" cx="50%" cy="28%" r="82%">
  <stop offset="0" stop-color="#10243d"/><stop offset=".58" stop-color="#07111f"/><stop offset="1" stop-color="#02050c"/>
 </radialGradient>
 <linearGradient id="sentence-caption-scrim" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#02050c" stop-opacity="0"/><stop offset=".38" stop-color="#02050c" stop-opacity=".52"/>
  <stop offset="1" stop-color="#02050c" stop-opacity=".92"/>
 </linearGradient>
 <filter id="sentence-soft-glow" x="-40%" y="-40%" width="180%" height="180%">
  <feGaussianBlur stdDeviation="3.5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
 </filter>
</defs>
<rect width="720" height="1280" fill="url(#sentence-bg)"/>
<g id="sentence-ambient-grid" opacity="${usesSceneComposition ? ".08" : ".2"}" data-qa-layer="ambient">
 ${Array.from({ length: 14 }, (_, index) => (
    `<line x1="${48 + index * 48}" y1="180" x2="${48 + index * 48}" y2="914" stroke="#164e63" stroke-width="1"/>`
  )).join("")}
 ${Array.from({ length: 16 }, (_, index) => (
    `<line x1="42" y1="${190 + index * 46}" x2="678" y2="${190 + index * 46}" stroke="#164e63" stroke-width="1"/>`
  )).join("")}
</g>
<rect x="36" y="180" width="648" height="746" fill="none"
 data-semantic-roi="true" data-geometry-audit="semantic-roi" pointer-events="none"/>
<g id="semantic-sentence-header" data-entity-id="semantic_sentence_header" data-caption-policy="avoid">
 <text x="54" y="56" class="composition-kicker">${escapeSemanticSentenceXml(plan.kicker)}</text>
 ${titleMarkup}
</g>
<g id="semantic-sentence-stack"${usesSceneComposition
    ? ` data-visual-scene-count="${visualGroups.length}"`
    : ""}>${sentenceMarkup}</g>
<rect x="0" y="948" width="720" height="332" class="caption-scrim"
 data-caption-safe-zone="true" pointer-events="none"/>
</svg></main>
<script>
"use strict";
const DATA=${runtimeData};
const clamp=(value,min=0,max=1)=>Math.max(min,Math.min(max,value));
const ease=(value)=>{const x=clamp(value);return x*x*(3-2*x)};${usesSceneComposition ? `
// A uniform opacity ramp keeps the single explainer entrance perceptually
// smooth without a long sub-threshold tail that reads as a stalled scene.
const revealEase=(value)=>clamp(value);` : ""}
${stageCollectionRuntime}${stageResetRuntime}
const setOpacity=(element,value)=>{if(element)element.setAttribute("opacity",clamp(value).toFixed(4))};${usesSceneActions ? `
${semanticSceneActionRuntimeSource()}` : ""}
${simpleAutoLayoutRuntime}
function renderFrame(rawFrame){
 const frame=Math.max(0,Math.min(DATA.durationFrames-1,Math.floor((Number(rawFrame)||0)+1e-7)));
${stageSelectionRuntime}${stageResetAtFrameRuntime}${simpleAutoLayoutAtFrameRuntime}
 stages.forEach((element,index)=>{
  const visible=index===${usesSceneComposition ? "visualIndex" : "activeIndex"};
  element.setAttribute("opacity",visible?"1":"0");
  element.style.pointerEvents=visible?"auto":"none";${stageVisibilityRuntime}
  element.dataset.focusRole=visible?"primary":"inactive";
  element.dataset.sentenceProgress=visible?semanticProgress.toFixed(4):"0.0000";
 });
${stageTransformRuntime}${boundedGeometryRuntime}${sceneCompositionRevealRuntime}${usesSceneComposition ? `
 stage.querySelectorAll(".semantic-draw").forEach((path)=>{
  path.style.strokeDasharray="none";
  path.style.strokeDashoffset="0";
 });
 stage.querySelectorAll(".semantic-rise").forEach((element)=>{
  element.setAttribute("opacity","1");
  element.setAttribute("transform","translate(0 0)");
 });
 const secondaryStartFrame=visual.presentationTiming.secondaryRevealStartFrame;
 const secondaryProgress=secondaryStartFrame!==null
  ?ease((frame-secondaryStartFrame)/visual.presentationTiming.secondaryRevealDurationFrames)
  :0;
 stage.querySelectorAll('[data-semantic-step-heading="primary"]').forEach((element)=>{
  setOpacity(element,1-secondaryProgress);
 });
 stage.querySelectorAll('[data-semantic-step-heading="secondary"]').forEach((element)=>{
  setOpacity(element,secondaryProgress);
 });
 stage.querySelectorAll(".semantic-step-secondary").forEach((element)=>{
  setOpacity(element,secondaryProgress);
  element.setAttribute("transform","translate(0 0)");
 });
 stage.querySelectorAll(".semantic-step-primary-only").forEach((element)=>{
  setOpacity(element,1-secondaryProgress);
  element.setAttribute("transform","translate(0 0)");
 });` : `
 stage.querySelectorAll(".semantic-draw").forEach((path)=>{
  path.style.strokeDasharray="1000";
  path.style.strokeDashoffset=String(1000*(1-semanticProgress));
 });
 stage.querySelectorAll(".semantic-rise").forEach((element,index)=>{
  const local=ease((semanticProgress-index*.07)/.54);
  element.setAttribute("opacity",local.toFixed(4));
  element.setAttribute("transform","translate(0 "+(18*(1-local)).toFixed(3)+")");
 });`}
 const oldCounter=stage.querySelector(".semantic-counter-old"),newCounter=stage.querySelector(".semantic-counter-new");
 if(oldCounter&&newCounter){
  const change=${counterTransitionExpression};
  setOpacity(oldCounter,1-change);setOpacity(newCounter,change);
  oldCounter.setAttribute("transform","translate(0 "+(-32*change).toFixed(3)+")");
  newCounter.setAttribute("transform","translate(0 "+(32*(1-change)).toFixed(3)+")");
  const pointer=stage.querySelector(".semantic-cycle-pointer");
  pointer?.setAttribute("transform","rotate("+(330*${transitionRotationExpression}).toFixed(3)+" 360 472)");
 }
 const vessel=stage.querySelector(".semantic-vessel-solid"),absence=stage.querySelector(".semantic-vessel-absence");
 if(vessel&&absence){
  const vanish=${vesselTransitionExpression};
  setOpacity(vessel,1-vanish);setOpacity(absence,vanish);
  vessel.setAttribute("transform","translate(0 "+(-12*vanish).toFixed(3)+")");
  stage.querySelector(".semantic-blizzard")?.setAttribute("transform","translate("+(-30+60*semanticProgress).toFixed(3)+" 0)");
 }
 const route=stage.querySelector(".semantic-route-path"),routeMarker=stage.querySelector(".semantic-route-marker");
 if(route&&routeMarker){
  const length=typeof route.getTotalLength==="function"?route.getTotalLength():500;${routeProgressSetupRuntime}${routePointRuntime}
  routeMarker.setAttribute("transform","translate("+Number(point.x).toFixed(3)+" "+Number(point.y).toFixed(3)+")");
  route.setAttribute("opacity",${routeProgressExpression}.toFixed(4));
  route.style.strokeDashoffset=${usesSceneComposition
    ? '"0"'
    : '(-2.6*(frame-active.startFrame)).toFixed(3)'};
 }
 stage.querySelectorAll(".semantic-chronology-dot").forEach((element,index)=>{
  setOpacity(element,ease((semanticProgress-index*.17)/.28));
 });
 const magnifier=stage.querySelector(".semantic-magnifier");
 if(magnifier)magnifier.setAttribute("transform","translate("+(-90+90*semanticProgress).toFixed(3)+" "+(32*(1-semanticProgress)).toFixed(3)+")");
 const boundary=stage.querySelector(".semantic-uncertainty-boundary");
 if(boundary)boundary.style.strokeDashoffset=(-32*semanticProgress).toFixed(3);
 document.documentElement.dataset.activeVisualStateId=active.sentenceId;
 document.documentElement.dataset.activeSemanticSentenceId=active.sentenceId;
 document.documentElement.dataset.activePropositionId=active.propositionId;
 document.documentElement.dataset.activeAssetId=active.assetId;
 document.documentElement.dataset.activeGrammarId=active.grammarId;
 document.documentElement.dataset.activeCapabilityPredicate=active.capability.predicate;
 document.documentElement.dataset.activeCapabilitySubjectKind=active.capability.subjectKind;
 document.documentElement.dataset.activeCapabilityStateTransition=active.capability.stateTransition;
 document.documentElement.dataset.activeClaimIds=active.claimIds.join(",");
 document.documentElement.dataset.focusPrimaryEntityId=active.focusEntityId;${sceneCompositionDatasetRuntime}${sceneActionDatasetRuntime}${simplePresentationRuntime}
 document.documentElement.dataset.renderedFrame=String(frame);
}
let currentTime=0,rate=1;
const timeline={duration:()=>DATA.durationFrames/DATA.fps,time(value){if(value===undefined)return currentTime;currentTime=clamp(Number(value)||0,0,this.duration());renderFrame(currentTime*DATA.fps);return this},totalTime(value){return value===undefined?currentTime:this.time(value)},seek(value){return this.time(value)},pause(){return this},play(){return this},timeScale(value){if(value===undefined)return rate;rate=Number(value)||1;return this},getChildren(){return[]},renderFrame};
window.__timelines=window.__timelines||{};
window.__timelines[${safeJson(plan.compositionId)}]=timeline;
window.__renderFrame=renderFrame;
renderFrame(0);
</script></body></html>`;
  return Object.freeze({
    html,
    compositionHash: createHash("sha256").update(html).digest("hex"),
    font: Object.freeze({
      family: FONT_FAMILY,
      sha256: FONT_SHA256,
      license: FONT_LICENSE,
      sourcePackage: "@fontsource/outfit",
    }),
    profile: Object.freeze({
      schemaVersion: SEMANTIC_SENTENCE_ANIMATION_SCHEMA_VERSION,
      profile: SEMANTIC_SENTENCE_ANIMATION_PROFILE,
      profileVersion: SEMANTIC_SENTENCE_ANIMATION_PROFILE_VERSION,
      profileId: SEMANTIC_SENTENCE_CONTENT_PROFILE_ID,
      provider: SEMANTIC_SENTENCE_ANIMATION_PROVIDER,
      runtimeVersion: SEMANTIC_SENTENCE_ANIMATION_RUNTIME_VERSION,
      styleVersion: SEMANTIC_SENTENCE_ANIMATION_STYLE_VERSION,
      sentencePlanHash: plan.sentencePlan.contentHash,
      ...(usesSceneComposition ? {
        presentationProfileId: SEMANTIC_SIMPLE_EXPLAINER_PROFILE_ID,
        visualSceneCount: visualGroups.length,
      } : {}),
      ...(usesSceneActions ? {
        sceneDslPlanHash: plan.sceneDslPlan.contentHash,
        sceneActionScheduleHash: presentedSceneActionSchedule.contentHash,
      } : {}),
    }),
    ...(usesSceneActions
      ? { actionQa: semanticSceneActionQaPlan(presentedSceneActionSchedule) }
      : {}),
  });
}
