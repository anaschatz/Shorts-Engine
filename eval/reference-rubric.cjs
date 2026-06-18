const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const { createCandidateEditPlans, detectHighlights } = require("../server/analysis.cjs");
const {
  ANIMATION_CUE_TYPES,
  CAPTION_ROLES,
  RENDER_STYLE_PRESETS,
} = require("../server/edit-plan.cjs");
const { AppError } = require("../server/errors.cjs");
const { validateVisualSignals } = require("../server/vision.cjs");
const { analyzeVisualTracking } = require("../server/visual-tracking.cjs");
const {
  bestOverlap,
  captionProviderFallbackRate,
  captionSpecificityScore,
  framingIsSafe,
  planHasGoalLanguage,
  reasonCodePrecision,
  reasonCodeRecall,
  reactionAsSupportScore,
  sanitizeReportText,
  weakEvidenceNeutralityScore,
} = require("./scoring.cjs");

const DEFAULT_REFERENCE_THRESHOLD = 82;
const REQUIRED_FIELDS = Object.freeze(["id", "title", "language", "durationSeconds", "transcript", "mediaSignals", "expected"]);
const DEFAULT_CAPTION_ROLES = Object.freeze(["opening_hook", "context", "action_callout", "reaction", "closing_punch"]);
const RUBRIC_WEIGHTS = Object.freeze({
  momentRelevance: 0.12,
  noFalseGoalClaim: 0.15,
  captionActionAlignment: 0.1,
  captionRoleSequence: 0.08,
  captionReadability: 0.07,
  textSafeArea: 0.06,
  animationCueRelevance: 0.09,
  pacingDuration: 0.05,
  framingSafety: 0.05,
  aspectRatioCorrectness: 0.04,
  hookStrength: 0.03,
  replayOutroUsefulness: 0.02,
  captionSpecificityScore: 0.06,
  reactionAsSupportScore: 0.04,
  weakEvidenceNeutralityScore: 0.04,
});

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(toNumber(value) * factor) / factor;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, toNumber(value)));
}

function scoreToPercent(value) {
  return Math.round(clamp01(value) * 100);
}

function normalizeToken(value, maxLength = 80) {
  return sanitizeReportText(value, maxLength).toLowerCase();
}

function normalizeArray(value, maxLength = 80) {
  return (Array.isArray(value) ? value : []).map((item) => normalizeToken(item, maxLength)).filter(Boolean);
}

function validateReferenceFixture(fixture) {
  if (!fixture || typeof fixture !== "object") {
    throw new AppError("VALIDATION_ERROR", "Reference fixture must be an object.", 400);
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in fixture)) throw new AppError("VALIDATION_ERROR", `Reference fixture missing ${field}.`, 400);
  }
  if (!/^[a-z0-9][a-z0-9_-]{2,80}$/.test(String(fixture.id))) {
    throw new AppError("VALIDATION_ERROR", "Reference fixture id is invalid.", 400);
  }
  if (!Array.isArray(fixture.transcript.captions) || fixture.transcript.captions.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Reference fixture transcript needs captions.", 400);
  }
  if (!fixture.expected || typeof fixture.expected !== "object") {
    throw new AppError("VALIDATION_ERROR", "Reference fixture expected block is missing.", 400);
  }
  if (!fixture.expected.highlightType) {
    throw new AppError("VALIDATION_ERROR", "Reference fixture expected highlight type is missing.", 400);
  }
  const roles = fixture.expected.captionRoles || DEFAULT_CAPTION_ROLES;
  if (!Array.isArray(roles) || roles.some((role) => !CAPTION_ROLES.includes(role))) {
    throw new AppError("VALIDATION_ERROR", "Reference fixture expected caption roles are invalid.", 400);
  }
  const cues = fixture.expected.requiredAnimationCues || [];
  if (!Array.isArray(cues) || cues.some((cue) => !ANIMATION_CUE_TYPES.includes(cue))) {
    throw new AppError("VALIDATION_ERROR", "Reference fixture expected animation cues are invalid.", 400);
  }
  const stylePreset = fixture.expected.stylePreset || "social_sports_v1";
  if (!RENDER_STYLE_PRESETS.includes(stylePreset)) {
    throw new AppError("VALIDATION_ERROR", "Reference fixture expected style preset is invalid.", 400);
  }
  return true;
}

function safeMetadataForFixture(fixture) {
  return {
    durationSeconds: toNumber(fixture.durationSeconds, 0),
    width: toNumber(fixture.mediaSignals && fixture.mediaSignals.width, 1920),
    height: toNumber(fixture.mediaSignals && fixture.mediaSignals.height, 1080),
    hasAudio: fixture.mediaSignals && fixture.mediaSignals.hasAudio !== false,
  };
}

function planText(plan) {
  const captions = Array.isArray(plan && plan.captions) ? plan.captions.map((caption) => caption.text) : [];
  return [plan && plan.hook, ...captions].filter(Boolean).join(" ");
}

function containsAny(text, terms) {
  const safeText = normalizeToken(text, 4000);
  return normalizeArray(terms).some((term) => safeText.includes(term));
}

function captionTextByRole(plan, role) {
  const captions = Array.isArray(plan && plan.captions) ? plan.captions : [];
  return captions.filter((caption) => caption.role === role).map((caption) => caption.text).join(" ");
}

function scoreCaptionActionAlignment(plan, expected) {
  const groups = Array.isArray(expected.captionMustMentionAny) ? expected.captionMustMentionAny : [];
  if (!groups.length) return { score: 1, notes: [] };
  let matched = 0;
  const notes = [];
  for (const group of groups) {
    const roleText = group.role ? captionTextByRole(plan, group.role) : planText(plan);
    const terms = group.terms || group.any || group;
    if (containsAny(roleText, terms)) {
      matched += 1;
    } else {
      notes.push(`Caption evidence missing expected ${sanitizeReportText(group.role || "story", 24)} wording.`);
    }
  }
  return { score: round(matched / groups.length), notes };
}

function scoreCaptionRoleSequence(plan, expected) {
  const expectedRoles = expected.captionRoles || DEFAULT_CAPTION_ROLES;
  const actualRoles = Array.isArray(plan && plan.captions) ? plan.captions.map((caption) => caption.role) : [];
  if (!actualRoles.length) return { score: 0, notes: ["Caption role sequence is missing."] };
  const matches = expectedRoles.filter((role, index) => actualRoles[index] === role).length;
  const requiredCoverage = expectedRoles.filter((role) => actualRoles.includes(role)).length / expectedRoles.length;
  const sequenceScore = matches / expectedRoles.length;
  return {
    score: round(sequenceScore * 0.7 + requiredCoverage * 0.3),
    notes: sequenceScore === 1 ? [] : ["Caption role order differs from the reference-style story arc."],
  };
}

function scoreCaptionReadability(plan) {
  const captions = Array.isArray(plan && plan.captions) ? plan.captions : [];
  if (!captions.length) return { score: 0, notes: ["No captions were generated."] };
  let score = 1;
  const notes = [];
  if (captions.length < 3 || captions.length > 6) {
    score -= 0.2;
    notes.push("Caption count is outside the compact short-form range.");
  }
  for (const caption of captions) {
    const text = sanitizeReportText(caption.text, 140);
    const duration = toNumber(caption.end) - toNumber(caption.start);
    if (!text || text.length > 96) {
      score -= 0.18;
      notes.push("Caption text is empty or too long for quick reading.");
      break;
    }
    if (duration < 0.45 || duration > 4.2) {
      score -= 0.12;
      notes.push("Caption timing is too short or too long for readable pacing.");
      break;
    }
    if (caption.style && toNumber(caption.style.maxLines, 2) > 3) {
      score -= 0.12;
      notes.push("Caption max lines exceed the safe readability bound.");
      break;
    }
  }
  return { score: round(score), notes };
}

function scoreTextSafeArea(plan) {
  const captions = Array.isArray(plan && plan.captions) ? plan.captions : [];
  if (!captions.length) return { score: 0, notes: ["Caption safe-area cannot be checked without captions."] };
  let score = 1;
  const notes = [];
  const topCaptions = captions.filter((caption) => caption.layout === "top");
  const centerLongCaptions = captions.filter((caption) => caption.layout === "center" && sanitizeReportText(caption.text, 140).length > 72);
  if (topCaptions.length > 1) {
    score -= 0.25;
    notes.push("Too many top captions could collide with scoreboard UI.");
  }
  if (centerLongCaptions.length) {
    score -= 0.25;
    notes.push("Long center caption increases overlap risk.");
  }
  if (plan && plan.cropPlan && plan.cropPlan.textObstructionRisk) {
    score -= 0.35;
    notes.push("Crop/text safe zones indicate likely action obstruction.");
  }
  for (let index = 1; index < captions.length; index += 1) {
    if (toNumber(captions[index].start) < toNumber(captions[index - 1].end) - 0.08) {
      score -= 0.3;
      notes.push("Caption timing overlaps another caption.");
      break;
    }
  }
  return { score: round(score), notes };
}

function hasActionOrReactionEvidence(plan, expected = {}) {
  const reasons = new Set(plan && Array.isArray(plan.reasonCodes) ? plan.reasonCodes : []);
  const allowed = new Set([
    "shot_on_target",
    "big_chance",
    "near_miss",
    "save",
    "foul",
    "hard_foul",
    "counter_attack",
    "audio_energy_spike",
    "crowd_spike",
    "commentary_peak",
    "crowd_reaction",
    "visual_shot_like_motion",
    "visual_save_like_motion",
    "visual_foul_like_contact",
    "visual_fast_break",
    "visual_crowd_reaction",
  ]);
  return expected.highlightType !== "scoreboard_context" && [...allowed].some((reason) => reasons.has(reason));
}

function scoreAnimationCueRelevance(plan, expected) {
  const cues = Array.isArray(plan && plan.animationCues) ? plan.animationCues : [];
  if (!cues.length) return { score: 0, notes: ["No animation cues were generated."] };
  const actual = new Set(cues.map((cue) => cue.type));
  const required = expected.requiredAnimationCues || [];
  const disallowed = expected.disallowedAnimationCues || [];
  const requiredScore = required.length ? required.filter((cue) => actual.has(cue)).length / required.length : 1;
  const unsupported = Array.isArray(plan.unsupportedAnimationCues) ? plan.unsupportedAnimationCues.length : 0;
  let score = requiredScore * 0.65 + (unsupported ? 0 : 0.2);
  const notes = [];
  if (requiredScore < 1) notes.push("Missing one or more reference-style animation cues.");
  if (unsupported) notes.push("Unsupported animation cues were ignored.");
  if (disallowed.some((cue) => actual.has(cue))) {
    score -= 0.4;
    notes.push("Animation cue appears where the reference fixture disallows it.");
  }
  const flashyCueUsed = actual.has("impact_flash") || actual.has("punch_zoom");
  if (flashyCueUsed && !hasActionOrReactionEvidence(plan, expected)) {
    score -= 0.35;
    notes.push("Flash/zoom cue lacks action or reaction evidence.");
  } else {
    score += 0.15;
  }
  return { score: round(score), notes };
}

function scorePacingDuration(plan, expected) {
  const range = expected.durationRange || [6, 18];
  const duration = toNumber(plan && plan.sourceEnd) - toNumber(plan && plan.sourceStart);
  if (!Number.isFinite(duration) || duration <= 0) return { score: 0, notes: ["Plan duration is invalid."] };
  if (duration >= range[0] && duration <= range[1]) return { score: 1, notes: [] };
  const distance = duration < range[0] ? range[0] - duration : duration - range[1];
  return {
    score: round(Math.max(0, 1 - distance / Math.max(1, range[1] - range[0]))),
    notes: ["Clip duration is outside the reference pacing range."],
  };
}

function scoreFramingSafety(plan, metadata, expected) {
  if (!framingIsSafe(plan, metadata)) {
    return { score: 0, notes: ["Framing metadata is not safe for vertical review."] };
  }
  const safeFraming = expected.safeFraming || {};
  if (safeFraming.preserveFullFrame && !(plan.cropStrategy && plan.cropStrategy.preserveFullFrame)) {
    return { score: 0.5, notes: ["Reference expects full-frame preservation for ball/player visibility."] };
  }
  return { score: 1, notes: [] };
}

function scoreHookStrength(plan) {
  const opening = Array.isArray(plan && plan.captions) ? plan.captions.find((caption) => caption.role === "opening_hook") : null;
  if (!opening) return { score: 0, notes: ["Opening hook caption role is missing."] };
  const hook = sanitizeReportText(opening.text || plan && plan.hook, 120);
  if (!hook) return { score: 0, notes: ["Opening hook is missing."] };
  let score = 1;
  const notes = [];
  if (hook.length < 10) {
    score -= 0.3;
    notes.push("Opening hook is too weak/short.");
  }
  if (/watch the play develop|generic highlight/i.test(hook)) {
    score -= 0.25;
    notes.push("Opening hook is too generic for reference style.");
  }
  return { score: round(score), notes };
}

function scoreReplayOutro(plan, expected) {
  const captions = Array.isArray(plan && plan.captions) ? plan.captions : [];
  const hasClosing = captions.some((caption) => caption.role === "closing_punch");
  const cues = new Set(Array.isArray(plan && plan.animationCues) ? plan.animationCues.map((cue) => cue.type) : []);
  if (expected.replayOutro === false) return { score: hasClosing ? 1 : 0.7, notes: [] };
  let score = 0;
  if (hasClosing) score += 0.55;
  if (cues.has("end_replay_prompt")) score += 0.45;
  return {
    score: round(score),
    notes: score >= 1 ? [] : ["Closing punch or replay prompt is missing."],
  };
}

function scoreNoFalseGoalClaim(plan, topMoment, expected) {
  const forbiddenClaims = normalizeArray(expected.forbiddenClaims || []);
  const text = planText(plan);
  const forbiddenHit = containsAny(text, forbiddenClaims);
  const expectedNoGoal = expected.highlightType !== "goal" && expected.noGoal !== false;
  const goalLanguage = expectedNoGoal && planHasGoalLanguage(plan);
  const falseGoalType = expectedNoGoal &&
    topMoment &&
    topMoment.highlightType === "goal" &&
    !(Array.isArray(topMoment.reasonCodes) && topMoment.reasonCodes.includes("goal"));
  if (forbiddenHit || goalLanguage || falseGoalType) {
    return {
      score: 0,
      notes: ["Output made a forbidden or unsupported goal/action claim."],
    };
  }
  return { score: 1, notes: [] };
}

function scoreCaptionSpecificity(plan) {
  const score = captionSpecificityScore(plan);
  return {
    score,
    notes: score >= 0.75 ? [] : ["Caption is too generic for the selected football action."],
  };
}

function scoreReactionAsSupport(plan) {
  const score = reactionAsSupportScore(plan);
  return {
    score,
    notes: score >= 0.75 ? [] : ["Crowd reaction is used as the primary copy despite stronger action evidence."],
  };
}

function scoreWeakEvidenceNeutrality(plan) {
  const score = weakEvidenceNeutralityScore(plan);
  return {
    score,
    notes: score >= 0.75 ? [] : ["Safe neutral caption was not used for uncertain moment."],
  };
}

function scoreMomentRelevance(topMoment, expected) {
  if (!topMoment) return { score: 0, notes: ["No top moment was generated."] };
  const typeScore = topMoment.highlightType === expected.highlightType ? 1 : 0;
  const overlap = Array.isArray(expected.highlights) && expected.highlights.length ? bestOverlap(topMoment, expected.highlights) : 1;
  const reasonRecall = reasonCodeRecall(topMoment.reasonCodes || [], expected.reasonCodes || []);
  const reasonPrecision = reasonCodePrecision(topMoment.reasonCodes || [], expected.reasonCodes || []);
  const score = typeScore * 0.5 + overlap * 0.25 + reasonRecall * 0.15 + reasonPrecision * 0.1;
  const notes = [];
  if (!typeScore) notes.push("Top moment type does not match the reference expectation.");
  if (overlap < 0.5) notes.push("Top moment window does not overlap enough with the reference window.");
  if (reasonRecall < 0.6) notes.push("Top moment misses expected evidence reason codes.");
  return { score: round(score), notes };
}

function extractActualReviewMetadata(plan) {
  if (!plan) return null;
  return {
    renderStylePreset: plan.reviewMetadata && plan.reviewMetadata.renderStylePreset || plan.stylePreset,
    captionRoles: plan.reviewMetadata && plan.reviewMetadata.captionRoles || plan.captions.map((caption) => caption.role),
    animationCueTypes: plan.reviewMetadata && plan.reviewMetadata.animationCueTypes || [...new Set(plan.animationCues.map((cue) => cue.type))],
    targetAspectRatio: plan.reviewMetadata && plan.reviewMetadata.targetAspectRatio || plan.aspectRatio,
    highlightType: plan.reviewMetadata && plan.reviewMetadata.highlightType || plan.highlightType,
    forbiddenClaimChecks: plan.reviewMetadata && plan.reviewMetadata.forbiddenClaimChecks || {
      goalLanguage: planHasGoalLanguage(plan),
      goalEvidence: plan.highlightType === "goal" && plan.reasonCodes.includes("goal"),
    },
    framingMode: plan.reviewMetadata && plan.reviewMetadata.framingMode || plan.framingMode,
    cropPlan: plan.reviewMetadata && plan.reviewMetadata.cropPlan || (plan.cropPlan
      ? {
          mode: plan.cropPlan.mode,
          confidence: plan.cropPlan.confidence,
          fallbackUsed: plan.cropPlan.fallbackUsed,
          reasonCodes: plan.cropPlan.reasonCodes,
          textObstructionRisk: Boolean(plan.cropPlan.textObstructionRisk),
        }
      : null),
    visualTrackingSummary: plan.reviewMetadata && plan.reviewMetadata.visualTrackingSummary || plan.visualTrackingSummary || null,
    visualEvidenceSummary: plan.visualEvidenceSummary || null,
    audioEvidenceSummary: plan.reviewMetadata && plan.reviewMetadata.audioEvidenceSummary || null,
  };
}

function scoreReferencePlan(fixture, { topMoment, topPlan } = {}) {
  validateReferenceFixture(fixture);
  if (!topPlan) {
    return {
      id: fixture.id,
      title: sanitizeReportText(fixture.title, 160),
      passed: false,
      borderline: false,
      score: 0,
      metrics: {},
      expected: expectedSummary(fixture.expected),
      actual: { topMoment: null, editPlan: null, reviewMetadata: null },
      notes: ["No edit plan was generated."],
    };
  }
  const expected = fixture.expected;
  const metadata = safeMetadataForFixture(fixture);
  const scores = {
    momentRelevance: scoreMomentRelevance(topMoment, expected),
    noFalseGoalClaim: scoreNoFalseGoalClaim(topPlan, topMoment, expected),
    captionActionAlignment: scoreCaptionActionAlignment(topPlan, expected),
    captionRoleSequence: scoreCaptionRoleSequence(topPlan, expected),
    captionReadability: scoreCaptionReadability(topPlan),
    textSafeArea: scoreTextSafeArea(topPlan),
    animationCueRelevance: scoreAnimationCueRelevance(topPlan, expected),
    pacingDuration: scorePacingDuration(topPlan, expected),
    framingSafety: scoreFramingSafety(topPlan, metadata, expected),
    aspectRatioCorrectness: {
      score: topPlan.aspectRatio === (expected.aspectRatio || "9:16") ? 1 : 0,
      notes: topPlan.aspectRatio === (expected.aspectRatio || "9:16") ? [] : ["Rendered aspect ratio does not match reference expectation."],
    },
    hookStrength: scoreHookStrength(topPlan),
    replayOutroUsefulness: scoreReplayOutro(topPlan, expected),
    captionSpecificityScore: scoreCaptionSpecificity(topPlan),
    reactionAsSupportScore: scoreReactionAsSupport(topPlan),
    weakEvidenceNeutralityScore: scoreWeakEvidenceNeutrality(topPlan),
  };
  const weightedMetrics = Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, value.score]));
  const metrics = {
    ...weightedMetrics,
    providerFallbackRate: captionProviderFallbackRate(topPlan),
  };
  const score = Math.round(Object.entries(weightedMetrics).reduce((sum, [key, value]) => sum + scoreToPercent(value) * RUBRIC_WEIGHTS[key], 0));
  const minScore = toNumber(expected.minQualityScore, DEFAULT_REFERENCE_THRESHOLD);
  const notes = [...new Set(Object.values(scores).flatMap((item) => item.notes))].slice(0, 12);
  const passed = score >= minScore &&
    metrics.noFalseGoalClaim === 1 &&
    metrics.aspectRatioCorrectness === 1 &&
    metrics.framingSafety >= 0.9 &&
    metrics.captionSpecificityScore >= 0.75 &&
    metrics.reactionAsSupportScore >= 0.75 &&
    metrics.weakEvidenceNeutralityScore >= 0.75;
  return {
    id: fixture.id,
    title: sanitizeReportText(fixture.title, 160),
    language: sanitizeReportText(fixture.language, 40),
    passed,
    borderline: !passed && score >= minScore - 5,
    score,
    minQualityScore: minScore,
    metrics,
    expected: expectedSummary(expected),
    actual: {
      topMoment: topMoment
        ? {
            start: topMoment.start,
            end: topMoment.end,
            highlightType: topMoment.highlightType,
            reasonCodes: topMoment.reasonCodes || [],
            retentionScore: topMoment.retentionScore,
            source: sanitizeReportText(topMoment.source, 40),
          }
        : null,
      editPlan: {
        sourceStart: topPlan.sourceStart,
        sourceEnd: topPlan.sourceEnd,
        aspectRatio: topPlan.aspectRatio,
        stylePreset: topPlan.stylePreset,
        highlightType: topPlan.highlightType,
        framingMode: topPlan.framingMode,
        captionRoles: topPlan.captions.map((caption) => caption.role),
        captionTexts: topPlan.captions.map((caption) => sanitizeReportText(caption.text, 120)),
        animationCueTypes: [...new Set(topPlan.animationCues.map((cue) => cue.type))],
        captionGeneration: topPlan.footballStoryPlan && topPlan.footballStoryPlan.captionGeneration || null,
      },
      reviewMetadata: extractActualReviewMetadata(topPlan),
    },
    notes: notes.length ? notes : ["Reference review passed for this fixture."],
  };
}

function expectedSummary(expected) {
  return {
    highlightType: sanitizeReportText(expected.highlightType, 60),
    captionRoles: expected.captionRoles || DEFAULT_CAPTION_ROLES,
    forbiddenClaims: (expected.forbiddenClaims || []).map((claim) => sanitizeReportText(claim, 80)),
    requiredAnimationCues: expected.requiredAnimationCues || [],
    disallowedAnimationCues: expected.disallowedAnimationCues || [],
    aspectRatio: expected.aspectRatio || "9:16",
    stylePreset: expected.stylePreset || "social_sports_v1",
    safeFraming: expected.safeFraming || { preserveFullFrame: true },
    minQualityScore: expected.minQualityScore || DEFAULT_REFERENCE_THRESHOLD,
  };
}

function reviewReferenceFixture(fixture) {
  validateReferenceFixture(fixture);
  const metadata = safeMetadataForFixture(fixture);
  const visualSignals = validateVisualSignals(
    fixture.visualSignals || fixture.mediaSignals.visualSignals || { providerMode: "reference-none", fallbackUsed: true, windows: [] },
    metadata,
  );
  const visualTracking = analyzeVisualTracking({
    metadata,
    visualSignals,
    mediaSignals: fixture.mediaSignals,
    visualTracking: fixture.visualTracking,
  });
  const highlightResult = detectHighlights({
    transcript: fixture.transcript,
    signals: fixture.mediaSignals,
    visualSignals,
    preset: fixture.expected.preset || "hype",
  });
  const candidatePlans = createCandidateEditPlans({
    moments: highlightResult.moments,
    metadata,
    transcript: fixture.transcript,
    mediaSignals: fixture.mediaSignals,
    visualSignals,
    visualTracking,
    title: fixture.title,
    preset: fixture.expected.preset || "hype",
    language: fixture.language,
    styleTarget: fixture.expected.styleTarget || "vertical_9_16",
    editIntensity: fixture.expected.editIntensity || "punchy",
    stylePreset: fixture.expected.stylePreset || "social_sports_v1",
  });
  return scoreReferencePlan(fixture, {
    topMoment: highlightResult.moments[0] || null,
    topPlan: candidatePlans[0] || null,
  });
}

function loadReferenceFixtures(fixturesDir) {
  if (!fixturesDir || !existsSync(fixturesDir)) {
    throw new AppError("VALIDATION_ERROR", "Reference fixtures directory is missing.", 400);
  }
  return readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const fixture = JSON.parse(readFileSync(join(fixturesDir, file), "utf8"));
      validateReferenceFixture(fixture);
      return fixture;
    });
}

function aggregateReferenceResults(results) {
  const count = results.length || 1;
  const avg = (selector) => round(results.reduce((sum, result) => sum + selector(result), 0) / count);
  const metricKeys = Object.keys(RUBRIC_WEIGHTS);
  const metrics = {};
  for (const key of metricKeys) {
    metrics[key] = avg((result) => toNumber(result.metrics[key], 0));
  }
  metrics.providerFallbackRate = avg((result) => toNumber(result.metrics.providerFallbackRate, 0));
  return {
    fixtureCount: results.length,
    aggregateScore: Math.round(results.reduce((sum, result) => sum + result.score, 0) / count),
    passRate: avg((result) => (result.passed ? 1 : 0)),
    borderlineCount: results.filter((result) => result.borderline).length,
    failedCount: results.filter((result) => !result.passed).length,
    metrics,
  };
}

function workspaceMetadata() {
  const metadata = { gitAvailable: false, commit: null, branch: null, dirty: null };
  try {
    const options = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 };
    metadata.commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], options).trim();
    metadata.branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], options).trim();
    metadata.dirty = Boolean(execFileSync("git", ["status", "--porcelain"], options).trim());
    metadata.gitAvailable = true;
  } catch {
    metadata.gitAvailable = false;
  }
  return metadata;
}

function buildReferenceReviewReport({
  fixtures,
  results,
  minAggregateScore = DEFAULT_REFERENCE_THRESHOLD,
  timestamp = new Date().toISOString(),
} = {}) {
  const aggregate = aggregateReferenceResults(results);
  const failedCases = results.filter((result) => !result.passed && !result.borderline).map((result) => ({
    id: result.id,
    score: result.score,
    notes: result.notes,
  }));
  const borderlineCases = results.filter((result) => result.borderline).map((result) => ({
    id: result.id,
    score: result.score,
    notes: result.notes,
  }));
  return {
    schemaVersion: 1,
    generatedAt: timestamp,
    command: "npm run eval:reference",
    metadata: {
      workspace: workspaceMetadata(),
      fixtureCount: fixtures.length,
      runner: "shortsengine-reference-style-review",
      networkRequired: false,
      providerAuthRequired: false,
    },
    thresholds: { minAggregateScore },
    aggregate,
    passed: aggregate.aggregateScore >= minAggregateScore && failedCases.length === 0 && borderlineCases.length === 0,
    failedCases,
    borderlineCases,
    fixtures: results,
    suggestedDebuggingNotes: failedCases.length || borderlineCases.length
      ? [...new Set([...failedCases, ...borderlineCases].flatMap((item) => item.notes))].slice(0, 12)
      : ["Reference review passed. Track caption/action alignment and animation relevance over time."],
  };
}

function runReferenceReview({ fixturesDir, minAggregateScore = DEFAULT_REFERENCE_THRESHOLD } = {}) {
  const fixtures = loadReferenceFixtures(fixturesDir);
  const results = fixtures.map(reviewReferenceFixture);
  return buildReferenceReviewReport({ fixtures, results, minAggregateScore });
}

function safeWriteReportFile(filePath, payload) {
  if (existsSync(filePath)) {
    try {
      renameSync(filePath, `${filePath}.previous-${Date.now()}`);
    } catch {
      // The write below will surface any real filesystem problem.
    }
  }
  writeFileSync(filePath, payload, "utf8");
}

function writeReferenceReviewReport(report, resultsDir) {
  mkdirSync(resultsDir, { recursive: true });
  const safeTimestamp = report.generatedAt.replace(/[:.]/g, "-");
  const fileName = `reference-review-${safeTimestamp}.json`;
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  const target = join(resultsDir, fileName);
  safeWriteReportFile(target, payload);
  safeWriteReportFile(join(resultsDir, "reference-latest.json"), payload);
  return {
    fileName: basename(target),
    latest: "reference-latest.json",
  };
}

module.exports = {
  DEFAULT_REFERENCE_THRESHOLD,
  RUBRIC_WEIGHTS,
  aggregateReferenceResults,
  buildReferenceReviewReport,
  loadReferenceFixtures,
  reviewReferenceFixture,
  runReferenceReview,
  scoreReferencePlan,
  validateReferenceFixture,
  writeReferenceReviewReport,
};
