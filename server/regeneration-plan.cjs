const { createHash, randomUUID } = require("node:crypto");
const { AppError } = require("./errors.cjs");
const {
  ANIMATION_CUE_TYPES,
  createAnimationCues,
  createCaptionEmphasis,
  createCropStrategy,
  hasGoalLanguage,
  hookForHighlightType,
  validateEditPlan,
} = require("./edit-plan.cjs");
const { sanitizeText, validateResourceId } = require("./repositories/ids.cjs");
const { registerReviewDraft } = require("../eval/review-registration.cjs");
const { validateReviewSuggestion } = require("../eval/review-fix-suggestions.cjs");
const { findReviewSensitiveLeak } = require("../eval/review-comparison.cjs");

const REGENERATION_PLAN_SCHEMA_VERSION = 1;
const MAX_SUGGESTIONS = 12;
const MAX_BLOCKING_REASONS = 12;
const MAX_CAPTIONS = 20;
const MAX_ANIMATION_CUES = 10;
const MAX_HUMAN_NOTES_LENGTH = 500;
const DEFAULT_VERTICAL_EXPORT = Object.freeze({ width: 1080, height: 1920, format: "mp4" });
const SAFE_TOKEN_RE = /^[a-z0-9][a-z0-9_:-]{1,100}$/i;
const EXPLICIT_GOAL_REASONS = new Set(["goal", "explicit_goal_evidence", "scoreboard_goal_evidence"]);
const MANUAL_ONLY_TYPES = new Set(["moment_reselection", "reviewer_manual_check"]);

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(toNumber(value) * factor) / factor;
}

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function draftHashFor(value) {
  return createHash("sha256").update(stableStringify(value || null)).digest("hex").slice(0, 32);
}

function safeToken(value, fallback = "unknown", maxLength = 80) {
  const token = sanitizeText(value || fallback, maxLength).toLowerCase().replace(/[^a-z0-9_:-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return SAFE_TOKEN_RE.test(token) ? token : fallback;
}

function safeId(value, fallbackPrefix = "regen") {
  const token = sanitizeText(value || "", 120).toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (/^[a-z0-9][a-z0-9_-]{2,100}$/.test(token)) return token;
  return `${fallbackPrefix}_${randomUUID()}`;
}

function hasExplicitGoalEvidence(plan = {}) {
  const highlightType = safeToken(plan.highlightType, "generic_highlight", 40);
  const reasonCodes = Array.isArray(plan.reasonCodes) ? plan.reasonCodes.map((reason) => safeToken(reason, null, 80)).filter(Boolean) : [];
  return highlightType === "goal" && reasonCodes.some((reason) => EXPLICIT_GOAL_REASONS.has(reason));
}

function metadataFromPlan(plan = {}, metadata = {}) {
  const sourceEnd = toNumber(plan.sourceEnd, 1);
  return {
    durationSeconds: Math.max(1, toNumber(metadata.durationSeconds ?? metadata.sourceDurationSeconds ?? plan.sourceDurationSeconds, sourceEnd)),
    width: Math.max(1, toNumber(metadata.width ?? plan.sourceWidth ?? plan.width, 1920)),
    height: Math.max(1, toNumber(metadata.height ?? plan.sourceHeight ?? plan.height, 1080)),
  };
}

function durationOf(plan = {}) {
  return Math.max(0.5, toNumber(plan.sourceEnd, 1) - toNumber(plan.sourceStart, 0));
}

function sanitizedReasons(plan = {}) {
  return Array.isArray(plan.reasonCodes)
    ? [...new Set(plan.reasonCodes.map((reason) => safeToken(reason, null, 80)).filter(Boolean))].slice(0, 20)
    : [];
}

function neutralHighlightType(plan = {}) {
  const highlightType = safeToken(plan.highlightType, "generic_highlight", 40);
  if (highlightType === "goal" && !hasExplicitGoalEvidence(plan)) return "generic_highlight";
  return highlightType;
}

function captionTextFor(highlightType, role, index = 0) {
  const beats = {
    goal: ["THE FINISH IS CLEAR", "WATCH THE BUILD-UP", "REPLAY THE TIMING"],
    shot_on_target: ["THE SHOT TESTS THE KEEPER", "PRESSURE BUILDS FAST", "REPLAY THE CHANCE"],
    near_miss: ["SO CLOSE TO A BIG MOMENT", "THE CROWD REACTS", "RUN IT BACK"],
    big_chance: ["THE CHANCE OPENS", "ONE TOUCH CREATES DANGER", "REPLAY THE TIMING"],
    save: ["THE KEEPER REACTS", "THE SAVE KEEPS IT ALIVE", "RUN IT BACK"],
    foul: ["CONTACT CHANGES THE TEMPO", "THE REACTION TELLS THE STORY", "WATCH THE AFTERMATH"],
    hard_foul: ["HEAVY CONTACT", "THE MATCH GETS HEATED", "REPLAY THE CHALLENGE"],
    card_moment: ["THE REF HAS A DECISION", "EVERYONE REACTS", "WATCH THE SHIFT"],
    counter_attack: ["SPACE OPENS FAST", "THE BREAK IS ON", "WATCH THE RUNNER"],
    skill_move: ["ONE TOUCH OPENS SPACE", "THE DEFENDER HAS TO TURN", "REPLAY THE MOVE"],
    crowd_reaction: ["THE CROWD TELLS THE STORY", "THE ENERGY JUMPS", "RUN IT BACK"],
    commentator_peak: ["THE CALL TELLS YOU THE MOMENT", "THE PRESSURE JUMPS", "WATCH THE REACTION"],
    replay_or_reaction: ["THE DETAIL IS IN THE BUILD-UP", "WATCH IT AGAIN", "REPLAY-WORTHY"],
    replay_worthy_moment: ["THE DETAIL IS IN THE BUILD-UP", "WATCH IT AGAIN", "REPLAY-WORTHY"],
    audio_energy_spike: ["THE ENERGY JUMPS", "LISTEN TO THE REACTION", "WATCH THE BUILD-UP"],
    unknown_action: ["THE PRESSURE BUILDS", "THE PLAY OPENS UP", "WATCH THE DETAIL"],
    generic_highlight: ["THE PRESSURE BUILDS", "THE PLAY OPENS UP", "WATCH THE DETAIL"],
  };
  const safeType = safeToken(highlightType, "generic_highlight", 40);
  const set = beats[safeType] || beats.generic_highlight;
  if (role === "opening_hook") return set[0];
  if (role === "context") return set[1] || set[0];
  if (role === "closing_punch" || role === "reaction") return set[2] || set[1] || set[0];
  return set[index % set.length] || set[0];
}

function retimeCaptions(captions, duration) {
  const safeCaptions = (Array.isArray(captions) ? captions : []).slice(0, MAX_CAPTIONS);
  if (!safeCaptions.length) return [];
  const gap = 0.08;
  const usable = Math.max(0.7, duration - gap * (safeCaptions.length - 1));
  const segment = Math.max(0.55, Math.min(2.4, usable / safeCaptions.length));
  return safeCaptions.map((caption, index) => {
    const start = Math.min(Math.max(0, index * (segment + gap)), Math.max(0, duration - 0.45));
    const end = Math.min(duration, Math.max(start + 0.45, start + segment));
    return {
      ...caption,
      start: round(start),
      end: round(end),
    };
  });
}

function neutralizeGoalLanguage(plan, appliedChanges) {
  const hasGoalEvidence = hasExplicitGoalEvidence(plan);
  if (hasGoalEvidence) return plan;
  const nextType = neutralHighlightType(plan);
  plan.highlightType = nextType;
  plan.reasonCodes = sanitizedReasons(plan).filter((reason) => !EXPLICIT_GOAL_REASONS.has(reason));
  if (!plan.reasonCodes.length) plan.reasonCodes = [nextType];
  if (hasGoalLanguage(plan.hook)) {
    plan.hook = hookForHighlightType(nextType, plan.stylePreset);
  }
  plan.captions = (Array.isArray(plan.captions) ? plan.captions : []).slice(0, MAX_CAPTIONS).map((caption, index) => {
    if (!caption || typeof caption !== "object") return caption;
    if (!hasGoalLanguage(caption.text)) return caption;
    appliedChanges.add("unsupported_goal_language_removed");
    return {
      ...caption,
      text: captionTextFor(nextType, caption.role, index),
      captionRiskFlags: Array.isArray(caption.captionRiskFlags)
        ? caption.captionRiskFlags.filter((flag) => flag !== "goal_language_without_evidence")
        : [],
    };
  });
  return plan;
}

function rewriteCaptionsForEvidence(plan, appliedChanges) {
  const highlightType = neutralHighlightType(plan);
  plan.captions = (Array.isArray(plan.captions) ? plan.captions : []).slice(0, MAX_CAPTIONS).map((caption, index) => {
    if (!caption || typeof caption !== "object") return caption;
    const unsafeGoal = hasGoalLanguage(caption.text) && !hasExplicitGoalEvidence(plan);
    const generic = /watch this|insane|crazy|unbelievable|big moment|goal from/i.test(sanitizeText(caption.text, 120));
    if (!unsafeGoal && !generic && index > 1) return caption;
    appliedChanges.add("captions_aligned_to_evidence");
    return {
      ...caption,
      text: captionTextFor(highlightType, caption.role, index),
      captionEvidence: {
        ...(caption.captionEvidence && typeof caption.captionEvidence === "object" ? caption.captionEvidence : {}),
        alignedHighlightType: highlightType,
        highlightType,
        reasonCodes: sanitizedReasons(plan),
        goalEvidence: hasExplicitGoalEvidence(plan),
      },
    };
  });
  return plan;
}

function applyWideSafeFraming(plan, metadata, appliedChanges) {
  plan.framingMode = "wide_safe_vertical";
  plan.framingReason = "regeneration_wide_safe_after_review_suggestion";
  plan.actionFocusConfidence = Math.min(toNumber(plan.actionFocusConfidence, 0), 0.8);
  plan.cropStrategy = createCropStrategy(metadata, "wide_safe_vertical");
  plan.effects = [...new Set([...(Array.isArray(plan.effects) ? plan.effects : []), "wide_safe_framing"])];
  appliedChanges.add("wide_safe_framing_applied");
  return plan;
}

function applyAspectRatioFix(plan, appliedChanges) {
  plan.aspectRatio = "9:16";
  plan.export = { ...DEFAULT_VERTICAL_EXPORT };
  plan.styleTarget = "vertical_9_16_reference_style";
  appliedChanges.add("vertical_aspect_ratio_enforced");
  return plan;
}

function applyAnimationCueAdjustment(plan, appliedChanges) {
  const duration = durationOf(plan);
  const cues = createAnimationCues(duration, sanitizedReasons(plan))
    .filter((cue) => ANIMATION_CUE_TYPES.includes(cue.type))
    .slice(0, MAX_ANIMATION_CUES);
  plan.animationCues = cues;
  plan.effects = [...new Set([...(Array.isArray(plan.effects) ? plan.effects : []), "social_caption_pop", "caption_emphasis", "beat_sync_pulse"])];
  appliedChanges.add("animation_cues_rebuilt_from_allowed_schema");
  return plan;
}

function applyCaptionTimingAdjustment(plan, appliedChanges) {
  plan.captions = retimeCaptions(plan.captions, durationOf(plan));
  appliedChanges.add("caption_timing_bounded");
  return plan;
}

function applySuggestion(plan, suggestion, context) {
  if (MANUAL_ONLY_TYPES.has(suggestion.type)) {
    context.skippedSuggestionIds.push(suggestion.id);
    context.blockingReasons.push({
      code: suggestion.type === "moment_reselection" ? "MOMENT_RESELECTION_REQUIRES_HUMAN_REVIEW" : "REVIEWER_MANUAL_CHECK_REQUIRED",
      suggestionId: suggestion.id,
      message: suggestion.type === "moment_reselection"
        ? "Moment reselection is not auto-applied without stronger evidence."
        : "Operator confirmation is required before this draft can move toward render.",
    });
    return plan;
  }
  if (suggestion.type === "false_goal_guard") {
    context.appliedSuggestionIds.push(suggestion.id);
    return neutralizeGoalLanguage(plan, context.appliedChanges);
  }
  if (suggestion.type === "caption_rewrite" || suggestion.type === "evidence_strengthening") {
    context.appliedSuggestionIds.push(suggestion.id);
    return rewriteCaptionsForEvidence(plan, context.appliedChanges);
  }
  if (suggestion.type === "caption_timing_adjustment") {
    context.appliedSuggestionIds.push(suggestion.id);
    return applyCaptionTimingAdjustment(plan, context.appliedChanges);
  }
  if (suggestion.type === "framing_adjustment") {
    context.appliedSuggestionIds.push(suggestion.id);
    return applyWideSafeFraming(plan, context.metadata, context.appliedChanges);
  }
  if (suggestion.type === "aspect_ratio_fix") {
    context.appliedSuggestionIds.push(suggestion.id);
    return applyAspectRatioFix(plan, context.appliedChanges);
  }
  if (suggestion.type === "animation_cue_adjustment") {
    context.appliedSuggestionIds.push(suggestion.id);
    return applyAnimationCueAdjustment(plan, context.appliedChanges);
  }
  context.skippedSuggestionIds.push(suggestion.id);
  context.blockingReasons.push({
    code: "SUGGESTION_TYPE_UNHANDLED",
    suggestionId: suggestion.id,
    message: "This suggestion type needs manual review before regeneration.",
  });
  return plan;
}

function validateSuggestionSet(value) {
  return (Array.isArray(value) ? value : [])
    .slice(0, MAX_SUGGESTIONS)
    .map(validateReviewSuggestion);
}

function validateRegenerationPlan(plan, metadata) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new AppError("VALIDATION_ERROR", "Regeneration plan must be an object.", 400);
  }
  if (plan.schemaVersion !== REGENERATION_PLAN_SCHEMA_VERSION) {
    throw new AppError("VALIDATION_ERROR", "Regeneration plan schema version is unsupported.", 400);
  }
  safeId(plan.regenerationPlanId, "regen");
  if (plan.draftHash && !/^[a-f0-9]{16,64}$/.test(String(plan.draftHash))) {
    throw new AppError("VALIDATION_ERROR", "Regeneration draft hash is invalid.", 400);
  }
  if (!["draft", "not_needed"].includes(plan.status)) {
    throw new AppError("VALIDATION_ERROR", "Regeneration plan status is invalid.", 400);
  }
  if (plan.canRender !== false || plan.requiresHumanApproval !== true) {
    throw new AppError("VALIDATION_ERROR", "Regeneration plans must stay manual-only before render.", 400);
  }
  if (plan.projectId) validateResourceId(plan.projectId, "prj");
  if (plan.jobId) validateResourceId(plan.jobId, "job");
  if (plan.exportId) validateResourceId(plan.exportId, "exp");
  if (plan.proposedEditPlan) {
    validateEditPlan(plan.proposedEditPlan, metadata);
  }
  const leak = findReviewSensitiveLeak(plan);
  if (leak) {
    throw new AppError("VALIDATION_ERROR", "Regeneration plan contains unsafe data.", 400, { field: leak.path });
  }
  return plan;
}

function buildRegenerationPlan(options = {}) {
  const originalEditPlan = options.originalEditPlan;
  if (!originalEditPlan || typeof originalEditPlan !== "object" || Array.isArray(originalEditPlan)) {
    throw new AppError("VALIDATION_ERROR", "originalEditPlan is required before regeneration.", 400);
  }
  const suggestions = validateSuggestionSet(options.reviewSuggestions || (options.reviewReport && options.reviewReport.suggestions));
  const metadata = metadataFromPlan(originalEditPlan, options.sourceMetadata);
  const ids = options.ids || {};
  const createdAt = options.createdAt || new Date().toISOString();
  const sourceReviewId = ids.sourceReviewId ? safeId(ids.sourceReviewId, "review") : null;
  const base = {
    schemaVersion: REGENERATION_PLAN_SCHEMA_VERSION,
    regenerationPlanId: safeId(options.regenerationPlanId, "regen"),
    status: suggestions.length ? "draft" : "not_needed",
    sourceReviewId,
    projectId: ids.projectId ? validateResourceId(ids.projectId, "prj") : null,
    jobId: ids.jobId ? validateResourceId(ids.jobId, "job") : null,
    exportId: ids.exportId ? validateResourceId(ids.exportId, "exp") : null,
    appliedSuggestionIds: [],
    skippedSuggestionIds: [],
    proposedChanges: [],
    proposedEditPlan: null,
    draftHash: null,
    safetyChecks: [],
    blockingReasons: [],
    canRender: false,
    requiresHumanApproval: true,
    humanNotes: sanitizeText(options.humanNotes || "", MAX_HUMAN_NOTES_LENGTH),
    createdAt,
    nextAction: suggestions.length
      ? "Review this draft manually before a future approved render step."
      : "No regeneration draft is needed for this passing review.",
  };
  if (!suggestions.length) {
    base.safetyChecks.push({ code: "NO_REGENERATION_NEEDED", status: "passed" });
    base.draftHash = draftHashFor({
      status: base.status,
      projectId: base.projectId,
      jobId: base.jobId,
      exportId: base.exportId,
      proposedEditPlan: null,
    });
    return validateRegenerationPlan(base, metadata);
  }

  const proposed = jsonClone(originalEditPlan);
  const context = {
    metadata,
    appliedSuggestionIds: [],
    skippedSuggestionIds: [],
    blockingReasons: [],
    appliedChanges: new Set(),
  };
  suggestions.forEach((suggestion) => applySuggestion(proposed, suggestion, context));
  proposed.sourceWidth = metadata.width;
  proposed.sourceHeight = metadata.height;
  proposed.sourceDurationSeconds = metadata.durationSeconds;
  if (proposed.aspectRatio !== "1:1") {
    proposed.aspectRatio = "9:16";
    proposed.export = { ...DEFAULT_VERTICAL_EXPORT };
  } else if (!proposed.export) {
    proposed.export = { width: 1080, height: 1080, format: "mp4" };
  }
  if (!Array.isArray(proposed.effects)) {
    proposed.effects = ["wide_safe_framing", "social_caption_pop", "caption_emphasis", "brand_safe_template"];
  }
  proposed.reasonCodes = sanitizedReasons(proposed);
  if (!proposed.reasonCodes.length) proposed.reasonCodes = [neutralHighlightType(proposed)];
  proposed.hook = hasGoalLanguage(proposed.hook) && !hasExplicitGoalEvidence(proposed)
    ? hookForHighlightType(neutralHighlightType(proposed), proposed.stylePreset)
    : sanitizeText(proposed.hook || hookForHighlightType(neutralHighlightType(proposed), proposed.stylePreset), 96);
  proposed.captionEmphasis = createCaptionEmphasis(proposed.captions, neutralHighlightType(proposed));
  if (!Array.isArray(proposed.animationCues) || !proposed.animationCues.length) {
    proposed.animationCues = createAnimationCues(durationOf(proposed), proposed.reasonCodes);
  }
  const validatedEditPlan = validateEditPlan(proposed, metadata);
  base.appliedSuggestionIds = [...new Set(context.appliedSuggestionIds)];
  base.skippedSuggestionIds = [...new Set(context.skippedSuggestionIds)];
  base.blockingReasons = context.blockingReasons.slice(0, MAX_BLOCKING_REASONS);
  base.proposedChanges = [...context.appliedChanges].slice(0, 12);
  base.proposedEditPlan = validatedEditPlan;
  base.draftHash = draftHashFor({
    projectId: base.projectId,
    jobId: base.jobId,
    exportId: base.exportId,
    appliedSuggestionIds: base.appliedSuggestionIds,
    skippedSuggestionIds: base.skippedSuggestionIds,
    proposedChanges: base.proposedChanges,
    proposedEditPlan: validatedEditPlan,
  });
  base.safetyChecks = [
    {
      code: "NO_AUTO_RENDER",
      status: "passed",
    },
    {
      code: "HUMAN_APPROVAL_REQUIRED",
      status: "passed",
    },
    {
      code: "NO_FALSE_GOAL_CLAIM",
      status: hasExplicitGoalEvidence(validatedEditPlan) || ![
        validatedEditPlan.hook,
        ...(validatedEditPlan.captions || []).map((caption) => caption.text),
      ].some(hasGoalLanguage) ? "passed" : "blocked",
    },
    {
      code: "EDIT_PLAN_SCHEMA_VALID",
      status: "passed",
    },
  ];
  if (base.safetyChecks.some((check) => check.status !== "passed")) {
    base.blockingReasons.push({
      code: "SAFETY_CHECK_BLOCKED",
      message: "The draft still needs manual correction before it can ever be rendered.",
    });
  }
  return validateRegenerationPlan(base, metadata);
}

function createRegenerationPlanFromReviewRegistration(options = {}) {
  const registered = registerReviewDraft({
    projectId: options.projectId,
    jobId: options.jobId,
    exportId: options.exportId,
    rightsConfirmed: options.rightsConfirmed,
    reference: options.reference,
    reviewerNotes: options.reviewerNotes,
    title: options.title,
    rootDir: options.rootDir,
    write: false,
  });
  const editPlan = registered.draft.generatedMetadata.editPlan;
  const registration = registered.draft.generatedMetadata.registration;
  const selectedMoment = registered.draft.generatedMetadata.selectedMoment;
  const regenerationPlan = buildRegenerationPlan({
    originalEditPlan: editPlan,
    reviewReport: registered.comparisonPreview,
    reviewSuggestions: registered.comparisonPreview.suggestions,
    sourceMetadata: {
      durationSeconds: editPlan.sourceDurationSeconds || selectedMoment.end,
      width: editPlan.sourceWidth,
      height: editPlan.sourceHeight,
    },
    humanNotes: options.humanNotes,
    regenerationPlanId: options.regenerationPlanId,
    ids: {
      sourceReviewId: registered.draft.id,
      projectId: registration.projectId,
      jobId: registration.jobId,
      exportId: registration.exportId,
    },
  });
  return { registered, regenerationPlan };
}

module.exports = {
  REGENERATION_PLAN_SCHEMA_VERSION,
  buildRegenerationPlan,
  createRegenerationPlanFromReviewRegistration,
  draftHashFor,
  validateRegenerationPlan,
};
