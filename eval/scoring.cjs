const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const { createCandidateEditPlans, detectHighlights } = require("../server/analysis.cjs");
const {
  CAPTION_EMPHASIS,
  CAPTION_LAYOUTS,
  CAPTION_RISK_FLAGS,
  CAPTION_ROLES,
  RENDER_STYLE_PRESETS,
  hasGoalLanguage,
} = require("../server/edit-plan.cjs");
const { AppError } = require("../server/errors.cjs");
const { deterministicGoalEvidence, mergeGoalEvidenceIntoVisualSignals } = require("../server/goal-evidence-provider.cjs");
const { analyzeMatchEventTruth, publicMatchEventTruth } = require("../server/match-event-truth.cjs");
const { defaultOcrQaCalibration, publicOcrQaCalibration } = require("../server/ocr-qa-calibration.cjs");
const { deterministicScoreboardOcr } = require("../server/scoreboard-ocr.cjs");
const { analyzeTracking, publicTrackingProviderOutput, validateTrackingProviderOutput } = require("../server/tracking-provider.cjs");
const { validateVisualSignals } = require("../server/vision.cjs");
const { analyzeVisualTracking, validateCropPlan } = require("../server/visual-tracking.cjs");

const DEFAULT_THRESHOLDS = Object.freeze({
  minAggregateScore: 78,
  minTop1Overlap: 0.35,
  minTop3Recall: 0.67,
  minReasonPrecision: 0.5,
  minRetentionScore: 55,
});

const ACTION_HIGHLIGHT_TYPES = Object.freeze([
  "goal",
  "shot_on_target",
  "near_miss",
  "big_chance",
  "save",
  "foul",
  "hard_foul",
  "card_moment",
  "counter_attack",
  "skill_move",
]);

const GENERIC_HYPE_RE = /\b(?:THE ENERGY JUMPS|THE STADIUM TELLS|THE CROWD TELLS|WATCH THE DETAIL|THE PRESSURE BUILDS|THE PLAY OPENS UP|RUN IT BACK)\b/i;
const REACTION_REASON_CODES = Object.freeze([
  "audio_energy_spike",
  "audio_peak",
  "commentator_peak",
  "crowd_reaction",
  "crowd_spike",
  "visual_crowd_reaction",
]);
const REPLAY_REASON_CODES = Object.freeze([
  "replay_or_reaction",
  "replay_worthy_moment",
  "visual_replay_indicator",
]);
const CLEAR_CONTEXT_REASON_CODES = Object.freeze([
  "commentator_peak",
  "crowd_reaction",
  "crowd_spike",
  "replay_or_reaction",
  "replay_worthy_moment",
  "visual_crowd_reaction",
  "visual_replay_indicator",
]);
const ACTION_REASON_CODES = Object.freeze([
  "goal",
  "big_chance",
  "card_moment",
  "counter_attack",
  "foul",
  "hard_foul",
  "near_miss",
  "save",
  "shot_on_target",
  "skill_move",
  "visual_fast_break",
  "visual_foul_like_contact",
  "visual_keeper_action",
  "visual_ball_in_net",
  "visual_celebration_after_shot",
  "visual_ball_toward_goal",
  "visual_shot_contact",
  "visual_save_like_motion",
  "visual_shot_like_motion",
]);
const REACTION_TEXT_RE = /(?:crowd|stadium|reaction|noise|stands|supporters|κερκιδα|κερκίδα|αντιδραση|αντίδραση|γηπεδο|γήπεδο)/i;
const STRONG_ACTION_TEXT_RE = /(?:chance|shot|save|keeper|contact|challenge|counter|break|runner|space|almost|foul|pressure|sprint|run|window|stop|touch|angle|σουτ|φάση|ευκαιρία|απόκρουση|τερματοφύλακας|επαφή|μαρκάρισμα|αντεπίθεση|χώρος|γκολ|σκοραρ)/i;

const REQUIRED_FIXTURE_FIELDS = Object.freeze([
  "id",
  "title",
  "language",
  "durationSeconds",
  "transcript",
  "mediaSignals",
  "expected",
  "thresholds",
]);

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(toNumber(value) * factor) / factor;
}

function scoreToPercent(score) {
  return Math.max(0, Math.min(100, Math.round(toNumber(score) * 100)));
}

function sanitizeReportText(value, maxLength = 300) {
  return String(value ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/OPENAI_API_KEY=[^\s]+/g, "OPENAI_API_KEY=[redacted]")
    .replace(/\/Users\/[^\s"']+/g, "[redacted-path]")
    .replace(/\/private\/[^\s"']+/g, "[redacted-path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function validateWindow(window, label) {
  if (!window || typeof window !== "object") {
    throw new AppError("VALIDATION_ERROR", `${label} must be an object.`, 400);
  }
  const start = toNumber(window.start, Number.NaN);
  const end = toNumber(window.end, Number.NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new AppError("VALIDATION_ERROR", `${label} has an invalid start/end range.`, 400);
  }
  return { start, end };
}

function validateFixture(fixture) {
  if (!fixture || typeof fixture !== "object") {
    throw new AppError("VALIDATION_ERROR", "Fixture must be an object.", 400);
  }
  for (const field of REQUIRED_FIXTURE_FIELDS) {
    if (!(field in fixture)) throw new AppError("VALIDATION_ERROR", `Fixture missing ${field}.`, 400);
  }
  if (!/^[a-z0-9][a-z0-9_-]{2,80}$/.test(String(fixture.id))) {
    throw new AppError("VALIDATION_ERROR", "Fixture id is invalid.", 400);
  }
  if (!Array.isArray(fixture.transcript.captions) || fixture.transcript.captions.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Fixture transcript needs captions.", 400);
  }
  if (!Array.isArray(fixture.expected.highlights) || fixture.expected.highlights.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Fixture expected highlights are required.", 400);
  }
  fixture.expected.highlights.forEach((highlight, index) => validateWindow(highlight, `expected.highlights[${index}]`));
  if (!Array.isArray(fixture.expected.reasonCodes) || fixture.expected.reasonCodes.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Fixture expected reason codes are required.", 400);
  }
  return true;
}

function overlapRatio(candidate, expected) {
  const left = Math.max(toNumber(candidate.start), toNumber(expected.start));
  const right = Math.min(toNumber(candidate.end), toNumber(expected.end));
  const intersection = Math.max(0, right - left);
  const expectedDuration = Math.max(0.001, toNumber(expected.end) - toNumber(expected.start));
  return round(intersection / expectedDuration, 4);
}

function bestOverlap(candidate, expectedWindows) {
  return Math.max(0, ...(expectedWindows || []).map((expected) => overlapRatio(candidate, expected)));
}

function top3Recall(moments, expectedWindows, minOverlap) {
  const top = (moments || []).slice(0, 3);
  if (!expectedWindows || expectedWindows.length === 0) return 0;
  const covered = expectedWindows.filter((expected) => top.some((moment) => overlapRatio(moment, expected) >= minOverlap));
  return round(covered.length / expectedWindows.length, 4);
}

function reasonCodePrecision(actualReasons, expectedReasons) {
  const actual = [...new Set(actualReasons || [])];
  const expected = new Set(expectedReasons || []);
  if (!actual.length) return 0;
  const matches = actual.filter((reason) => expected.has(reason)).length;
  return round(matches / actual.length, 4);
}

function reasonCodeRecall(actualReasons, expectedReasons) {
  const actual = new Set(actualReasons || []);
  const expected = [...new Set(expectedReasons || [])];
  if (!expected.length) return 1;
  const matches = expected.filter((reason) => actual.has(reason)).length;
  return round(matches / expected.length, 4);
}

function expectedReasonCodesForScoring(expected = {}) {
  const base = Array.isArray(expected.reasonCodes) ? expected.reasonCodes : [];
  if (expected.goalSelectionMode !== "valid_goals_only") return base;
  return [...new Set([
    ...base,
    "ball_in_net",
    "scoreboard_backed_goal_sequence",
    "scoreboard_ocr_score_change",
    "scoreboard_temporal_consistency",
    "confirmed_by_commentary",
    "commentator_goal_call_support",
    "audio_energy_spike",
    "crowd_spike",
    "scene_change_cluster",
  ])];
}

function visualReasonCodes(reasons = []) {
  return (Array.isArray(reasons) ? reasons : []).filter((reason) => /^visual_/.test(reason));
}

function captionsHaveValidTiming(plan) {
  if (!plan || !Array.isArray(plan.captions) || plan.captions.length === 0) return false;
  const segmentDuration = Array.isArray(plan.segments)
    ? plan.segments.reduce((sum, segment) => sum + Math.max(0, toNumber(segment.sourceEnd) - toNumber(segment.sourceStart)), 0)
    : 0;
  const duration = toNumber(plan.totalDuration) || segmentDuration || (toNumber(plan.sourceEnd) - toNumber(plan.sourceStart));
  return plan.captions.every((caption) => {
    const start = toNumber(caption.start, Number.NaN);
    const end = toNumber(caption.end, Number.NaN);
    return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= duration + 0.25;
  });
}

function captionsHaveValidRoles(plan) {
  if (!plan || !Array.isArray(plan.captions) || plan.captions.length === 0) return false;
  const roles = plan.captions.map((caption) => caption && caption.role);
  if (!roles.includes("opening_hook")) return false;
  if (!roles.includes("closing_punch")) return false;
  return plan.captions.every((caption) => (
    caption &&
    CAPTION_ROLES.includes(caption.role) &&
    CAPTION_EMPHASIS.includes(caption.emphasis) &&
    CAPTION_LAYOUTS.includes(caption.layout) &&
    caption.timing &&
    Number.isFinite(Number(caption.timing.entranceMs)) &&
    Number.isFinite(Number(caption.timing.exitMs)) &&
    caption.style &&
    Number.isFinite(Number(caption.style.fontScale)) &&
    Number.isFinite(Number(caption.style.stroke)) &&
    Number.isFinite(Number(caption.style.shadow)) &&
    Number.isFinite(Number(caption.style.maxLines))
  ));
}

function captionEvidenceMetadataIsComplete(plan) {
  if (!plan || !Array.isArray(plan.captions) || plan.captions.length === 0) return false;
  const segmentHighlightTypes = new Set(
    Array.isArray(plan.segments)
      ? plan.segments.map((segment) => segment && segment.highlightType).filter(Boolean)
      : [],
  );
  return plan.captions.every((caption) => {
    const evidence = caption && caption.captionEvidence;
    const alignedType = evidence && evidence.alignedHighlightType;
    const alignedWithPlan = alignedType === plan.highlightType ||
      (plan.mode === "multi_moment_compilation" && (segmentHighlightTypes.has(alignedType) || alignedType === "generic_highlight"));
    return (
      caption &&
      typeof caption.captionIntent === "string" &&
      caption.captionIntent.length > 0 &&
      typeof caption.captionSource === "string" &&
      caption.captionSource.length > 0 &&
      evidence &&
      typeof evidence === "object" &&
      alignedWithPlan &&
      Array.isArray(evidence.reasonCodes) &&
      Array.isArray(evidence.visualReasonCodes) &&
      Array.isArray(caption.captionRiskFlags) &&
      caption.captionRiskFlags.every((flag) => CAPTION_RISK_FLAGS.includes(flag))
    );
  });
}

function planIsConfirmedGoalCompilation(plan = {}) {
  const segments = planSegments(plan);
  return segments.length > 0 && segments.every(isConfirmedValidGoalSegment);
}

function genericCaptionPenalty(plan) {
  if (!plan || !Array.isArray(plan.captions) || !ACTION_HIGHLIGHT_TYPES.includes(plan.highlightType)) return 0;
  const text = plan.captions.map((caption) => caption.text).join(" ");
  return GENERIC_HYPE_RE.test(text) ? 1 : 0;
}

function captionActionAlignmentScore(plan) {
  if (!plan || !Array.isArray(plan.captions) || plan.captions.length === 0) return 0;
  if (!captionEvidenceMetadataIsComplete(plan)) return 0;
  if (genericCaptionPenalty(plan)) return 0;
  const text = plan.captions.map((caption) => caption.text).join(" ");
  if (planIsConfirmedGoalCompilation(plan)) {
    return /(?:goal|finish|counts?|stands|confirmed|valid)/i.test(text) ? 1 : 0;
  }
  const goalOutcome = goalOutcomeForPlan(plan);
  if (goalOutcome && goalOutcome.outcome !== "confirmed_goal") {
    return /(?:decision|unclear|not clear|offside|flag|VAR|no goal|ball in the net|ruled out|disallowed)/i.test(text) &&
      !/\b(?:finish counts|goal confirmed|confirmed goal|goal stands)\b/i.test(text)
      ? 1
      : 0;
  }
  const checks = {
    shot_on_target: /\b(?:shot|chance|pressure|punished|timing)\b/i,
    near_miss: /\b(?:close|almost|angle|space|moment)\b/i,
    big_chance: /\b(?:chance|pressure|danger|punished|timing|run|window)\b/i,
    save: /\b(?:save|keeper|stop|reacts|chance)\b/i,
    foul: /\b(?:challenge|contact|tempo|reaction|aftermath)\b/i,
    hard_foul: /\b(?:contact|challenge|tempo|heavy|reaction)\b/i,
    card_moment: /\b(?:decision|referee|call|heated)\b/i,
    counter_attack: /\b(?:break|counter|space|run|runner|transition)\b/i,
    skill_move: /\b(?:touch|move|angle|defender|turn)\b/i,
    crowd_reaction: /\b(?:crowd|stadium|reaction|energy)\b/i,
    commentator_peak: /\b(?:call|commentary|pressure|moment)\b/i,
    audio_energy_spike: /\b(?:crowd|stadium|noise|energy|reaction)\b/i,
    replay_or_reaction: /\b(?:replay|timing|angle|detail)\b/i,
    replay_worthy_moment: /\b(?:replay|timing|angle|detail)\b/i,
    unknown_action: /\b(?:pressure|play|develop|detail)\b/i,
    generic_highlight: /\b(?:pressure|play|develop|detail)\b/i,
  };
  const matcher = checks[plan.highlightType];
  return !matcher || matcher.test(text) ? 1 : 0;
}

function captionText(plan) {
  return Array.isArray(plan && plan.captions) ? plan.captions.map((caption) => sanitizeReportText(caption.text, 120)).join(" ") : "";
}

function captionTextForRole(plan, role) {
  return Array.isArray(plan && plan.captions)
    ? plan.captions.filter((caption) => caption.role === role).map((caption) => sanitizeReportText(caption.text, 120)).join(" ")
    : "";
}

function captionSpecificityScore(plan) {
  if (!plan || !Array.isArray(plan.captions) || !plan.captions.length) return 0;
  const text = captionText(plan);
  if (planIsConfirmedGoalCompilation(plan)) {
    return /(?:goal|finish|counts?|stands|confirmed|valid|net)/i.test(text) ? 1 : 0;
  }
  const goalOutcome = goalOutcomeForPlan(plan);
  if (goalOutcome && goalOutcome.outcome !== "confirmed_goal") {
    return /(?:decision|unclear|not clear|offside|flag|VAR|no goal|ball in the net|ruled out|disallowed|net)/i.test(text) &&
      !/\b(?:finish counts|goal confirmed|confirmed goal|goal stands)\b/i.test(text)
      ? 1
      : 0;
  }
  const checks = {
    shot_on_target: /\b(?:shot|chance|pressure|angle|almost|timing|σουτ|πίεση|φάση)\b/i,
    near_miss: /\b(?:close|almost|angle|chance|timing|παραλίγο|γωνία|φάση)\b/i,
    big_chance: /\b(?:chance|pressure|danger|almost|timing|run|window|φάση|κίνδυνος|πίεση|τρέξιμο)\b/i,
    save: /\b(?:save|keeper|stop|reacts|denied|τερματοφύλακας|απόκρουση|επέμβαση)\b/i,
    foul: /\b(?:challenge|contact|tempo|reaction|aftermath|επαφή|μαρκάρισμα|ρυθμός)\b/i,
    hard_foul: /\b(?:contact|challenge|tempo|heavy|reaction|επαφή|μαρκάρισμα|δυνατό|βαρύ)\b/i,
    card_moment: /\b(?:decision|referee|call|heated|διαιτητής|απόφαση)\b/i,
    counter_attack: /\b(?:break|counter|space|run|runner|transition|αντεπίθεση|χώρος|τρέξιμο)\b/i,
    skill_move: /\b(?:touch|move|angle|defender|turn|άγγιγμα|κίνηση|γωνία)\b/i,
    crowd_reaction: REACTION_TEXT_RE,
    commentator_peak: /\b(?:call|commentary|pressure|moment|εκφωνητής|περιγραφή|πίεση)\b/i,
    audio_energy_spike: REACTION_TEXT_RE,
    replay_or_reaction: /\b(?:replay|timing|angle|detail|ξαναδές|λεπτομέρεια|γωνία)\b/i,
    replay_worthy_moment: /\b(?:replay|timing|angle|detail|ξαναδές|λεπτομέρεια|γωνία)\b/i,
    unknown_action: /\b(?:pressure|play|develop|detail|phase|πίεση|φάση|λεπτομέρεια)\b/i,
    generic_highlight: /\b(?:pressure|play|develop|detail|phase|πίεση|φάση|λεπτομέρεια)\b/i,
    goal: /(?:goal|finish|scored|scores|net|counts?|decision|offside|flag|ruled out|γκολ|σκοραρ|σκόραρ|φάση|τελείωμα|τελειωμα|απόφαση|οφσάιντ|οφσαιντ)/i,
  };
  const matcher = checks[plan.highlightType] || checks.generic_highlight;
  if (!matcher.test(text)) return 0;
  if (ACTION_HIGHLIGHT_TYPES.includes(plan.highlightType) && genericCaptionPenalty(plan)) return 0;
  return 1;
}

function reactionAsSupportScore(plan) {
  if (!plan || !Array.isArray(plan.reasonCodes)) return 0;
  if (planIsConfirmedGoalCompilation(plan)) return captionSpecificityScore(plan);
  if (plan.goalOutcome && plan.goalOutcome.eventType === "ball_in_net") return captionSpecificityScore(plan);
  const reasonSet = new Set(plan.reasonCodes);
  const hasReaction = REACTION_REASON_CODES.some((reason) => reasonSet.has(reason));
  const hasReplayContext = REPLAY_REASON_CODES.some((reason) => reasonSet.has(reason)) ||
    ["replay_or_reaction", "replay_worthy_moment"].includes(plan.highlightType);
  const hasAction = ACTION_REASON_CODES.some((reason) => reasonSet.has(reason)) || ACTION_HIGHLIGHT_TYPES.includes(plan.highlightType);
  if (hasReplayContext) return captionSpecificityScore(plan);
  if (!hasReaction) return 1;
  const openingAndAction = `${captionTextForRole(plan, "opening_hook")} ${captionTextForRole(plan, "action_callout")}`;
  const reactionText = captionTextForRole(plan, "reaction");
  if (hasAction) {
    if (REACTION_TEXT_RE.test(openingAndAction) && !STRONG_ACTION_TEXT_RE.test(openingAndAction)) return 0;
    return REACTION_TEXT_RE.test(reactionText) ? 1 : 0.5;
  }
  return REACTION_TEXT_RE.test(captionText(plan)) ? 1 : 0;
}

function weakEvidenceNeutralityScore(plan) {
  if (!plan || !Array.isArray(plan.reasonCodes)) return 0;
  if (planIsConfirmedGoalCompilation(plan)) return 1;
  const reasonSet = new Set(plan.reasonCodes);
  const hasAction = ACTION_REASON_CODES.some((reason) => reasonSet.has(reason));
  const hasClearContext = CLEAR_CONTEXT_REASON_CODES.some((reason) => reasonSet.has(reason));
  const weakEvidence = ["unknown_action", "generic_highlight"].includes(plan.highlightType) ||
    (["visual_goal_area", "visual_scoreboard_context", "visual_unknown_action"].some((reason) => reasonSet.has(reason)) && !hasAction && !hasClearContext);
  if (!weakEvidence) return 1;
  const text = captionText(plan);
  if (planHasGoalLanguage(plan)) return 0;
  if (/\b(?:scores?|finish(?:es)?|denied|save|foul|counter|scored|γκολ|σκόραρε|σκοραρ)\b/i.test(text)) return 0;
  return /\b(?:pressure|play|develop|detail|phase|πίεση|φάση|λεπτομέρεια|χτίζεται)\b/i.test(text) ? 1 : 0.5;
}

function captionProviderFallbackRate(plan) {
  return plan && plan.footballStoryPlan && plan.footballStoryPlan.captionGeneration && plan.footballStoryPlan.captionGeneration.fallbackUsed ? 1 : 0;
}

function goalEvidenceForPlan(plan) {
  const evidence = plan &&
    plan.analysisMoment &&
    plan.analysisMoment.evidence &&
    plan.analysisMoment.evidence.goalEvidence;
  return evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence : null;
}

function goalSequenceRecallScore(topMoment, topPlan, expected = {}) {
  if (expectedValidGoalWindows(expected).length) return validGoalRecallScore(topPlan, expected);
  if (expected.highlightType !== "goal") return 1;
  const goalEvidence = goalEvidenceForPlan(topPlan);
  if (!topMoment || !goalEvidence) return 0;
  if (!["strong", "medium"].includes(goalEvidence.evidenceLevel)) return 0;
  return topMoment.reasonCodes.includes("goal") && goalEvidence.goalClaimAllowed ? 1 : 0.75;
}

function shotToPayoffCoverageScore(topPlan, expected = {}) {
  const sequence = expected.goalSequence || expected.shotToPayoff || null;
  if (!sequence || typeof sequence !== "object") return 1;
  if (!topPlan) return 0;
  const shotStart = toNumber(sequence.shotStart, Number.NaN);
  const payoffEnd = toNumber(sequence.payoffEnd, Number.NaN);
  if (!Number.isFinite(shotStart) || !Number.isFinite(payoffEnd)) return 1;
  return topPlan.sourceStart <= shotStart + 0.25 && topPlan.sourceEnd >= payoffEnd - 0.25 ? 1 : 0;
}

function goalOutcomeForPlan(plan) {
  return plan && plan.goalOutcome && plan.goalOutcome.eventType === "ball_in_net" ? plan.goalOutcome : null;
}

function planSegments(plan = {}) {
  if (!plan) return [];
  if (Array.isArray(plan.segments) && plan.segments.length) return plan.segments;
  if (Number.isFinite(Number(plan.sourceStart)) && Number.isFinite(Number(plan.sourceEnd))) {
    return [plan];
  }
  return [];
}

function segmentWindow(segment = {}) {
  return {
    start: toNumber(segment.sourceStart ?? segment.start),
    end: toNumber(segment.sourceEnd ?? segment.end),
  };
}

function isConfirmedValidGoalSegment(segment = {}) {
  const outcome = segment.goalOutcome && segment.goalOutcome.eventType === "ball_in_net"
    ? segment.goalOutcome
    : null;
  return segment.highlightType === "goal" &&
    outcome &&
    outcome.outcome === "confirmed_goal" &&
    outcome.offsideStatus !== "offside";
}

function scoringMomentForValidGoalsOnly(topPlan, fallbackMoment = null) {
  const segment = planSegments(topPlan).find(isConfirmedValidGoalSegment);
  if (!segment) return fallbackMoment;
  return {
    start: segment.sourceStart,
    end: segment.sourceEnd,
    retentionScore: segment.retentionScore || topPlan.retentionScore || 0,
    reasonCodes: Array.isArray(segment.reasonCodes) ? segment.reasonCodes : [],
    highlightType: segment.highlightType,
    evidence: { goalOutcome: segment.goalOutcome },
    source: "valid_goals_only_final_plan",
  };
}

function expectedValidGoalWindows(expected = {}) {
  return Array.isArray(expected.validGoals) && expected.validGoals.length
    ? expected.validGoals.map((item) => validateWindow(item, "expected.validGoals[]"))
    : [];
}

function expectedFinalSegmentCount(expected = {}) {
  const explicit = Number(expected.finalSegmentCount ?? expected.expectedFinalSegmentCount);
  if (Number.isInteger(explicit) && explicit >= 0 && explicit <= 20) return explicit;
  if (expected.goalSelectionMode === "valid_goals_only") return expectedValidGoalWindows(expected).length;
  return null;
}

function expectedOffsideGoalWindows(expected = {}) {
  return Array.isArray(expected.offsideGoals) && expected.offsideGoals.length
    ? expected.offsideGoals.map((item) => validateWindow(item, "expected.offsideGoals[]"))
    : [];
}

function expectedNoGoalWindows(expected = {}) {
  const explicit = Array.isArray(expected.noGoalWindows) && expected.noGoalWindows.length
    ? expected.noGoalWindows
    : Array.isArray(expected.disallowedGoals) && expected.disallowedGoals.length
      ? expected.disallowedGoals
      : [];
  if (explicit.length) return explicit.map((item) => validateWindow(item, "expected.noGoalWindows[]"));
  if (expected.outcome === "disallowed_offside" || expected.outcome === "disallowed_no_goal") {
    return Array.isArray(expected.highlights) ? expected.highlights.map((item) => validateWindow(item, "expected.highlights[]")) : [];
  }
  return [];
}

function validGoalRecallScore(topPlan, expected = {}, minOverlap = 0.5) {
  const expectedGoals = expectedValidGoalWindows(expected);
  if (!expectedGoals.length) return 1;
  const confirmedSegments = planSegments(topPlan).filter(isConfirmedValidGoalSegment);
  const covered = expectedGoals.filter((goal) => confirmedSegments.some((segment) => overlapRatio(segmentWindow(segment), goal) >= minOverlap));
  return round(covered.length / expectedGoals.length, 4);
}

function lateGoalRecallScore(topPlan, expected = {}, durationSeconds = 0, minOverlap = 0.5) {
  const expectedGoals = expectedValidGoalWindows(expected);
  if (!expectedGoals.length) return 1;
  const lateCutoff = Math.max(0, toNumber(durationSeconds) * 0.66);
  const lateGoals = expectedGoals.filter((goal) => goal.start >= lateCutoff);
  if (!lateGoals.length) return 1;
  const confirmedSegments = planSegments(topPlan).filter(isConfirmedValidGoalSegment);
  const covered = lateGoals.filter((goal) => confirmedSegments.some((segment) => overlapRatio(segmentWindow(segment), goal) >= minOverlap));
  return round(covered.length / lateGoals.length, 4);
}

function falseGoalRateScore(topPlan, expected = {}, minOverlap = 0.35) {
  const expectedGoals = expectedValidGoalWindows(expected);
  const offsideGoals = expectedOffsideGoalWindows(expected);
  const confirmedSegments = planSegments(topPlan).filter(isConfirmedValidGoalSegment);
  if (!confirmedSegments.length) return 0;
  const falseGoals = confirmedSegments.filter((segment) => {
    const window = segmentWindow(segment);
    const matchesValid = expectedGoals.some((goal) => overlapRatio(window, goal) >= minOverlap);
    const matchesOffside = offsideGoals.some((goal) => overlapRatio(window, goal) >= minOverlap);
    return !matchesValid || matchesOffside;
  });
  return round(falseGoals.length / confirmedSegments.length, 4);
}

function offsideExclusionAccuracyForValidGoals(topPlan, expected = {}, minOverlap = 0.35) {
  const offsideGoals = expectedOffsideGoalWindows(expected);
  if (!offsideGoals.length) return 1;
  const confirmedSegments = planSegments(topPlan).filter(isConfirmedValidGoalSegment);
  return confirmedSegments.some((segment) => offsideGoals.some((goal) => overlapRatio(segmentWindow(segment), goal) >= minOverlap)) ? 0 : 1;
}

function noGoalExclusionAccuracyForValidGoals(topPlan, expected = {}, minOverlap = 0.35) {
  const noGoalWindows = expectedNoGoalWindows(expected);
  if (!noGoalWindows.length || expected.goalSelectionMode !== "valid_goals_only") return 1;
  const confirmedSegments = planSegments(topPlan).filter(isConfirmedValidGoalSegment);
  return confirmedSegments.some((segment) => noGoalWindows.some((goal) => overlapRatio(segmentWindow(segment), goal) >= minOverlap)) ? 0 : 1;
}

function validGoalOnlyFillerRate(topPlan, expected = {}) {
  if (expected.goalSelectionMode !== "valid_goals_only") return 0;
  const segments = planSegments(topPlan);
  if (!segments.length) return 1;
  const fillerSegments = segments.filter((segment) => !isConfirmedValidGoalSegment(segment));
  return round(fillerSegments.length / segments.length, 4);
}

function validGoalsOnlyExactSegmentCountScore(topPlan, expected = {}) {
  if (expected.goalSelectionMode !== "valid_goals_only") return 1;
  const expectedCount = expectedFinalSegmentCount(expected);
  if (expectedCount == null) return 1;
  const segments = planSegments(topPlan);
  const confirmedSegments = segments.filter(isConfirmedValidGoalSegment);
  return segments.length === expectedCount && confirmedSegments.length === expectedCount ? 1 : 0;
}

function validGoalOrderingScore(topPlan, expected = {}, minOverlap = 0.5) {
  if (expected.goalSelectionMode !== "valid_goals_only") return 1;
  const expectedGoals = expectedValidGoalWindows(expected);
  if (expectedGoals.length <= 1) return 1;
  const confirmedSegments = planSegments(topPlan).filter(isConfirmedValidGoalSegment);
  if (confirmedSegments.length !== expectedGoals.length) return 0;
  return expectedGoals.every((goal, index) => overlapRatio(segmentWindow(confirmedSegments[index]), goal) >= minOverlap) ? 1 : 0;
}

function validGoalsOnlyCoverageScore(topPlan, expected = {}, minOverlap = 0.5) {
  if (expected.goalSelectionMode !== "valid_goals_only") return 1;
  const expectedGoals = expectedValidGoalWindows(expected);
  if (!expectedGoals.length) return planSegments(topPlan).length ? 0 : 1;
  const recall = validGoalRecallScore(topPlan, expected, minOverlap);
  return validGoalOnlyFillerRate(topPlan, expected) === 0 ? recall : 0;
}

function cutSmoothnessScore(topPlan, expected = {}) {
  if (expected.goalSelectionMode !== "valid_goals_only") return 1;
  const qa = visualPolishQa(topPlan);
  if (qa && Number.isFinite(Number(qa.cutSmoothnessScore))) {
    return round(Number(qa.cutSmoothnessScore), 4);
  }
  const segments = planSegments(topPlan);
  if (!segments.length) return expectedValidGoalWindows(expected).length ? 0 : 1;
  const chronological = segments.every((segment, index) => index === 0 || toNumber(segment.sourceStart) >= toNumber(segments[index - 1].sourceEnd) - 0.25);
  const noDuplicateOverlap = segments.every((segment, index) => (
    index === 0 ||
    overlapRatio(segmentWindow(segment), segmentWindow(segments[index - 1])) <= 0.05
  ));
  const boundedDurations = segments.every((segment) => {
    const duration = toNumber(segment.sourceEnd) - toNumber(segment.sourceStart);
    return duration >= 10 && duration <= 30;
  });
  return chronological && noDuplicateOverlap && boundedDurations ? 1 : 0;
}

function excludedWindows(expected = {}, key) {
  return Array.isArray(expected[key]) && expected[key].length
    ? expected[key].map((item) => validateWindow(item, `expected.${key}[]`))
    : [];
}

function exclusionScore(topPlan, expected = {}, key, minOverlap = 0.35) {
  const windows = excludedWindows(expected, key);
  if (!windows.length) return 1;
  const segments = planSegments(topPlan);
  if (!segments.length) return 1;
  return segments.some((segment) => windows.some((window) => overlapRatio(segmentWindow(segment), window) >= minOverlap)) ? 0 : 1;
}

function celebrationOnlyExclusionScore(topPlan, expected = {}, minOverlap = 0.35) {
  return exclusionScore(topPlan, expected, "celebrationOnly", minOverlap);
}

function anthemIntroExclusionScore(topPlan, expected = {}, minOverlap = 0.35) {
  return exclusionScore(topPlan, expected, "anthemIntro", minOverlap);
}

function captionGoalClaimAccuracyScore(topPlan, expected = {}) {
  const expectedGoals = expectedValidGoalWindows(expected);
  const hasGoalCopy = planHasGoalLanguage(topPlan) || /(?:valid finishes?|finish(?:es)? counts?|goal confirmed|confirmed goal|goal stands)/i.test(captionText(topPlan));
  if (!expectedGoals.length) return hasGoalCopy ? 0 : 1;
  return hasGoalCopy && validGoalOnlyFillerRate(topPlan, expected) === 0 ? 1 : 0;
}

function segmentTimingCoverageScore(topPlan, expected = {}) {
  const expectedGoals = expectedValidGoalWindows(expected);
  if (!expectedGoals.length) return 1;
  const tolerance = expected.goalSelectionMode === "valid_goals_only" ? 0.75 : 0.25;
  const confirmedSegments = planSegments(topPlan).filter(isConfirmedValidGoalSegment);
  const covered = expectedGoals.filter((goal) => confirmedSegments.some((segment) => (
    toNumber(segment.sourceStart) <= goal.start + tolerance &&
    toNumber(segment.sourceEnd) >= goal.end - tolerance
  )));
  return round(covered.length / expectedGoals.length, 4);
}

function replayOnlyGoalRate(topPlan, expected = {}) {
  if (expected.goalSelectionMode !== "valid_goals_only") return 0;
  const confirmedSegments = planSegments(topPlan).filter(isConfirmedValidGoalSegment);
  if (!confirmedSegments.length) return expectedValidGoalWindows(expected).length ? 1 : 0;
  const replayOnly = confirmedSegments.filter((segment) => segment.replayOnly === true ||
    (segment.phaseCoverage && segment.phaseCoverage.replayOnly === true));
  return round(replayOnly.length / confirmedSegments.length, 4);
}

function goalPhaseCoverageScore(topPlan, expected = {}) {
  if (expected.goalSelectionMode !== "valid_goals_only" && !expected.goalPhaseCoverageRequired) return 1;
  const confirmedSegments = planSegments(topPlan).filter(isConfirmedValidGoalSegment);
  if (!confirmedSegments.length) return expectedValidGoalWindows(expected).length ? 0 : 1;
  const covered = confirmedSegments.filter((segment) => {
    const phase = segment.phaseCoverage || {};
    return segment.replayOnly !== true &&
      phase.replayOnly !== true &&
      phase.hasBuildup === true &&
      phase.hasShot === true &&
      phase.hasFinish === true &&
      phase.hasConfirmation === true;
  });
  return round(covered.length / confirmedSegments.length, 4);
}

function visualPolishQa(topPlan) {
  return topPlan && (
    topPlan.visualPolishQA ||
    (topPlan.reviewMetadata && topPlan.reviewMetadata.multiMoment && topPlan.reviewMetadata.multiMoment.visualPolishQA)
  ) || null;
}

function referenceVisualPolishScore(topPlan, expected = {}) {
  if (expected.goalSelectionMode !== "valid_goals_only") return 1;
  const qa = visualPolishQa(topPlan);
  if (!qa) return 0;
  if (Number.isFinite(Number(qa.score))) return round(Number(qa.score), 4);
  if (Number.isFinite(Number(qa.visualPolishScore))) return round(Number(qa.visualPolishScore) / 100, 4);
  return 0;
}

function abruptCutRiskCount(topPlan, expected = {}) {
  if (expected.goalSelectionMode !== "valid_goals_only") return 0;
  const qa = visualPolishQa(topPlan);
  if (qa && Number.isFinite(Number(qa.abruptCutRiskCount))) return Math.max(0, Math.round(Number(qa.abruptCutRiskCount)));
  return cutSmoothnessScore(topPlan, expected) >= 0.9 ? 0 : 1;
}

function goalEvidenceCoverageScore(goalEvidence, expected = {}) {
  const expectedGoals = expectedValidGoalWindows(expected);
  if (!expectedGoals.length) return 1;
  const validGoalCount = Number(goalEvidence && goalEvidence.summary && goalEvidence.summary.validGoalCount || 0);
  return round(Math.min(1, validGoalCount / expectedGoals.length), 4);
}

function expectedOcrEvidence(expected = {}) {
  return Array.isArray(expected.scoreboardOcr) && expected.scoreboardOcr.length
    ? expected.scoreboardOcr
    : Array.isArray(expected.ocrEvidence) && expected.ocrEvidence.length
      ? expected.ocrEvidence
      : [];
}

function ocrEvidenceCoverageScore(scoreboardOcr, expected = {}) {
  const expectedOcr = expectedOcrEvidence(expected);
  if (!expectedOcr.length) return 1;
  const actualCount = Number(scoreboardOcr && scoreboardOcr.summary && scoreboardOcr.summary.evidenceCount || 0);
  return round(Math.min(1, actualCount / expectedOcr.length), 4);
}

function scoreboardScoreChangeRecallScore(scoreboardOcr, expected = {}) {
  const expectedOcr = expectedOcrEvidence(expected).filter((item) => item.status === "score_changed" || item.scoreChanged);
  if (!expectedOcr.length) return 1;
  const actualCount = Number(scoreboardOcr && scoreboardOcr.summary && scoreboardOcr.summary.scoreChangeCount || 0);
  return round(Math.min(1, actualCount / expectedOcr.length), 4);
}

function ambiguousOcrFailClosedScore(goalEvidence, expected = {}) {
  if (!expected.expectAmbiguousOcrFailClosed) return 1;
  const validGoalCount = Number(goalEvidence && goalEvidence.summary && goalEvidence.summary.validGoalCount || 0);
  return validGoalCount === 0 ? 1 : 0;
}

function noFalseGoalFromOcrOnlyScore(goalEvidence, expected = {}) {
  if (!expected.ocrOnlyNoGoal) return 1;
  const validGoalCount = Number(goalEvidence && goalEvidence.summary && goalEvidence.summary.validGoalCount || 0);
  return validGoalCount === 0 ? 1 : 0;
}

function ocrQaCalibrationSupportScore(goalEvidence, expected = {}) {
  if (!expected.ocrQaCalibration) return 1;
  const calibration = goalEvidence && goalEvidence.ocrQaCalibration;
  if (!calibration || typeof calibration !== "object") return 0;
  const expectedLevel = expected.ocrQaCalibration.decisionSupportLevel || "ignore";
  return calibration.decisionSupportLevel === expectedLevel &&
    calibration.goalEvidencePolicy === "support_only" &&
    calibration.goalDecisionAllowed === false &&
    calibration.noFalseGoalFromOcrOnly === true
    ? 1
    : 0;
}

function truthEvents(matchEventTruth = {}) {
  return Array.isArray(matchEventTruth && matchEventTruth.events)
    ? matchEventTruth.events
    : Array.isArray(matchEventTruth && matchEventTruth.selectedEvents)
      ? matchEventTruth.selectedEvents
      : [];
}

function truthEventWindow(event = {}) {
  return {
    start: toNumber(event.sourceStart ?? event.start),
    end: toNumber(event.sourceEnd ?? event.end),
  };
}

function matchEventTruthValidGoalRecallScore(matchEventTruth, expected = {}, minOverlap = 0.5) {
  const expectedGoals = expectedValidGoalWindows(expected);
  if (!expectedGoals.length) return 1;
  const confirmed = truthEvents(matchEventTruth).filter((event) => event.type === "confirmed_goal");
  const covered = expectedGoals.filter((goal) => confirmed.some((event) => overlapRatio(truthEventWindow(event), goal) >= minOverlap));
  return round(covered.length / expectedGoals.length, 4);
}

function matchEventTruthLateGoalRecallScore(matchEventTruth, expected = {}, durationSeconds = 0, minOverlap = 0.5) {
  const expectedGoals = expectedValidGoalWindows(expected);
  if (!expectedGoals.length) return 1;
  const lateCutoff = Math.max(0, toNumber(durationSeconds) * 0.66);
  const lateGoals = expectedGoals.filter((goal) => goal.start >= lateCutoff);
  if (!lateGoals.length) return 1;
  const confirmed = truthEvents(matchEventTruth).filter((event) => event.type === "confirmed_goal");
  const covered = lateGoals.filter((goal) => confirmed.some((event) => overlapRatio(truthEventWindow(event), goal) >= minOverlap));
  return round(covered.length / lateGoals.length, 4);
}

function matchEventTruthDisallowedClassificationScore(matchEventTruth, expected = {}, minOverlap = 0.35) {
  const offsideGoals = expectedOffsideGoalWindows(expected);
  if (!offsideGoals.length) return 1;
  const disallowed = truthEvents(matchEventTruth).filter((event) => (
    event.type === "disallowed_offside" ||
    event.type === "disallowed_no_goal"
  ));
  const covered = offsideGoals.filter((goal) => disallowed.some((event) => overlapRatio(truthEventWindow(event), goal) >= minOverlap));
  return round(covered.length / offsideGoals.length, 4);
}

function matchEventTruthFalseGoalRateScore(matchEventTruth, expected = {}, minOverlap = 0.35) {
  const expectedGoals = expectedValidGoalWindows(expected);
  const offsideGoals = expectedOffsideGoalWindows(expected);
  const confirmed = truthEvents(matchEventTruth).filter((event) => event.type === "confirmed_goal");
  if (!confirmed.length) return 0;
  const falseGoals = confirmed.filter((event) => {
    const window = truthEventWindow(event);
    const matchesValid = expectedGoals.some((goal) => overlapRatio(window, goal) >= minOverlap);
    const matchesOffside = offsideGoals.some((goal) => overlapRatio(window, goal) >= minOverlap);
    return !matchesValid || matchesOffside;
  });
  return round(falseGoals.length / confirmed.length, 4);
}

function optionalExpectedCount(expected = {}, key) {
  const value = Number(expected[key]);
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

function matchEventTruthAnchorContractScore(matchEventTruth, expected = {}) {
  const keys = [
    "scoreChangeAnchorsFound",
    "anchorsWithLiveActionEvidence",
    "anchorsRejected",
    "selectedCountedGoals",
    "ocrOnlyBlockedCount",
    "missingActionEvidenceCount",
  ];
  const expectedPairs = keys
    .map((key) => [key, optionalExpectedCount(expected, key)])
    .filter(([, value]) => value != null);
  if (!expectedPairs.length) return 1;
  const summary = matchEventTruth && matchEventTruth.summary && typeof matchEventTruth.summary === "object"
    ? matchEventTruth.summary
    : {};
  const matches = expectedPairs.filter(([key, expectedValue]) => {
    const actualValue = Math.max(0, Math.round(Number(summary[key] || 0)));
    return actualValue === expectedValue;
  }).length;
  return round(matches / expectedPairs.length, 4);
}

function expectedGoalOutcome(expected = {}) {
  return expected.goalOutcome && typeof expected.goalOutcome === "object" && !Array.isArray(expected.goalOutcome)
    ? expected.goalOutcome
    : null;
}

function offsideOutcomeAccuracyScore(topPlan, expected = {}) {
  const expectedOutcome = expectedGoalOutcome(expected);
  if (!expectedOutcome) return 1;
  const actual = goalOutcomeForPlan(topPlan);
  if (!actual) return 0;
  if (expectedOutcome.outcome && actual.outcome !== expectedOutcome.outcome) return 0;
  if (expectedOutcome.offsideStatus && actual.offsideStatus !== expectedOutcome.offsideStatus) return 0;
  return 1;
}

function disallowedGoalIncludedScore(topPlan, expected = {}) {
  const expectedOutcome = expectedGoalOutcome(expected);
  if (!expectedOutcome || expectedOutcome.outcome !== "disallowed_offside") return 1;
  const actual = goalOutcomeForPlan(topPlan);
  if (!actual || actual.outcome !== "disallowed_offside") return 0;
  return topPlan && topPlan.sourceEnd > topPlan.sourceStart ? 1 : 0;
}

function decisionContextCoverageScore(topMoment, topPlan, expected = {}) {
  const expectedOutcome = expectedGoalOutcome(expected);
  const expectedWindow = expectedOutcome && expectedOutcome.decisionWindow;
  if (!expectedWindow || typeof expectedWindow !== "object") return 1;
  const decisionEnd = toNumber(expectedWindow.end, Number.NaN);
  if (!Number.isFinite(decisionEnd)) return 1;
  const momentCovers = topMoment && toNumber(topMoment.end) >= decisionEnd - 0.25;
  const planCovers = topPlan && toNumber(topPlan.sourceEnd) >= decisionEnd - 0.25;
  return momentCovers && planCovers ? 1 : 0;
}

function captionOutcomeAlignmentScore(topPlan, expected = {}) {
  const expectedOutcome = expectedGoalOutcome(expected);
  if (!expectedOutcome) return 1;
  if (!topPlan) return 0;
  const text = captionText(topPlan);
  if (expectedOutcome.outcome === "confirmed_goal") return /(?:CONFIRMED GOAL|GOAL CONFIRMED|COUNTS|STANDS)/i.test(text) ? 1 : 0;
  if (expectedOutcome.outcome === "disallowed_offside") {
    return /(?:OFFSIDE|NO GOAL|FLAG|RULED OUT|DISALLOWED)/i.test(text) && !/\b(?:THE FINISH COUNTS|GOAL CONFIRMED)\b/i.test(text) ? 1 : 0;
  }
  if (expectedOutcome.outcome === "possible_offside") {
    return /(?:VAR CHECK|WAS HE OFF|POSSIBLE OFFSIDE|DECISION NOT CLEAR)/i.test(text) && !/\b(?:THE FINISH COUNTS|GOAL CONFIRMED)\b/i.test(text) ? 1 : 0;
  }
  if (expectedOutcome.outcome === "unknown_decision") {
    return /(?:BALL IN THE NET|DECISION UNCLEAR|DECISION NOT CLEAR)/i.test(text) && !/\b(?:THE FINISH COUNTS|GOAL CONFIRMED)\b/i.test(text) ? 1 : 0;
  }
  return 1;
}

function postGoalWindowCoverageScore(topMoment, expected = {}) {
  const expectedOutcome = expectedGoalOutcome(expected);
  const expectedWindow = expectedOutcome && expectedOutcome.decisionWindow;
  if (!expectedWindow || typeof expectedWindow !== "object") return 1;
  const decisionEnd = toNumber(expectedWindow.end, Number.NaN);
  if (!Number.isFinite(decisionEnd) || !topMoment) return Number.isFinite(decisionEnd) ? 0 : 1;
  return toNumber(topMoment.end) >= decisionEnd - 0.25 ? 1 : 0;
}

function actionWindowCoverageScore(topMoment, expectedWindows = []) {
  if (!topMoment || !expectedWindows.length) return 0;
  return Math.min(1, bestOverlap(topMoment, expectedWindows) / 0.75);
}

function ballPlayerVisibilityScore(topPlan) {
  const summary = topPlan && topPlan.visualEvidenceSummary;
  if (!summary || !Array.isArray(summary.topTypes) || !summary.topTypes.length) return 1;
  const types = new Set(summary.topTypes);
  if (types.has("ball_visible") || types.has("player_cluster")) return 1;
  return summary.windowCount > 0 && summary.actionFocusConfidence >= 0.7 ? 0.8 : 0.5;
}

function referenceStyleSimilarityScore(topPlan) {
  if (!topPlan) return 0;
  const roleScore = Array.isArray(topPlan.captions) && topPlan.captions.some((caption) => caption.role === "opening_hook") ? 0.35 : 0;
  const animationScore = Array.isArray(topPlan.animationCues) && topPlan.animationCues.length >= 3 ? 0.35 : 0;
  const cropMode = topPlan.cropPlan && topPlan.cropPlan.mode;
  const framingScore = topPlan.framingMode === "wide_safe_vertical" || cropMode === "soft_follow" ? 0.3 : 0.15;
  return round(roleScore + animationScore + framingScore, 4);
}

function cropPlanForPlan(plan, metadata = {}) {
  if (!plan || !plan.cropPlan) return null;
  try {
    return validateCropPlan(plan.cropPlan, metadata);
  } catch {
    return null;
  }
}

function cropSafetyScore(plan, metadata = {}) {
  const cropPlan = cropPlanForPlan(plan, metadata);
  if (!cropPlan) return 0;
  if (cropPlan.mode === "soft_follow" && (cropPlan.confidence < 0.86 || cropPlan.fallbackUsed)) return 0;
  if (cropPlan.mode !== "soft_follow" && cropPlan.fallbackUsed !== true) return 0;
  return 1;
}

function actionSafeZoneCoverageScore(plan, metadata = {}) {
  const cropPlan = cropPlanForPlan(plan, metadata);
  if (!cropPlan) return 0;
  if (!cropPlan.actionSafeZones.length) return 1;
  return cropPlan.actionSafeZones.every((zone) => (
    zone.x >= cropPlan.safeArea.x - 1 &&
    zone.y >= cropPlan.safeArea.y - 1 &&
    zone.x + zone.width <= cropPlan.safeArea.x + cropPlan.safeArea.width + 1 &&
    zone.y + zone.height <= cropPlan.safeArea.y + cropPlan.safeArea.height + 1
  )) ? 1 : 0;
}

function textObstructionRiskValue(plan, metadata = {}) {
  const cropPlan = cropPlanForPlan(plan, metadata);
  return cropPlan && cropPlan.textObstructionRisk ? 1 : 0;
}

function wideSafeFallbackRate(plan, metadata = {}) {
  const cropPlan = cropPlanForPlan(plan, metadata);
  return cropPlan && cropPlan.fallbackUsed ? 1 : 0;
}

function trackingConfidenceCalibrationScore(plan, expected = {}, metadata = {}) {
  const cropPlan = cropPlanForPlan(plan, metadata);
  if (!cropPlan) return 0;
  const expectedMode = expected.cropMode || expected.expectedCropMode || null;
  if (expectedMode) {
    if (expectedMode === "soft_follow") return cropPlan.mode === "soft_follow" && cropPlan.confidence >= 0.86 ? 1 : 0;
    return cropPlan.mode === expectedMode && cropPlan.fallbackUsed === true ? 1 : 0;
  }
  if (cropPlan.mode === "soft_follow") return cropPlan.confidence >= 0.86 && !cropPlan.fallbackUsed ? 1 : 0;
  return cropPlan.fallbackUsed && cropPlan.confidence <= 0.95 ? 1 : 0;
}

function trackingOutputValidityScore(output, metadata = {}) {
  try {
    validateTrackingProviderOutput(output, metadata);
    return 1;
  } catch {
    return 0;
  }
}

function ballTrackCoverageScore(output, expected = {}, metadata = {}) {
  const safe = validateTrackingProviderOutput(output, metadata);
  const expectsFollow = (expected.cropMode || expected.expectedCropMode) === "soft_follow";
  if (!expectsFollow) return 1;
  return safe.ballTracks.some((track) => track.confidence >= 0.65) ? 1 : 0;
}

function playerClusterCoverageScore(output, expected = {}, metadata = {}) {
  const safe = validateTrackingProviderOutput(output, metadata);
  const expectsFollow = (expected.cropMode || expected.expectedCropMode) === "soft_follow";
  if (!expectsFollow) return 1;
  return safe.playerClusters.some((cluster) => cluster.confidence >= 0.55) ? 1 : 0;
}

function softFollowPrecisionScore(plan, visualTracking = {}) {
  const cropPlan = plan && plan.cropPlan ? plan.cropPlan : null;
  if (!cropPlan || cropPlan.mode !== "soft_follow") return 1;
  return (
    !cropPlan.fallbackUsed &&
    !cropPlan.textObstructionRisk &&
    Number(visualTracking.ballCandidateConfidence || 0) >= 0.65 &&
    Number(visualTracking.playerClusterConfidence || 0) >= 0.55 &&
    Number(visualTracking.ballTrackCount || 0) > 0 &&
    Number(visualTracking.playerClusterCount || 0) > 0
  ) ? 1 : 0;
}

function wideSafeFallbackCorrectnessScore(plan, expected = {}) {
  const cropPlan = plan && plan.cropPlan ? plan.cropPlan : null;
  if (!cropPlan) return 0;
  const expectedMode = expected.cropMode || expected.expectedCropMode || null;
  if (expectedMode === "soft_follow") return 1;
  if (expectedMode) return cropPlan.mode === expectedMode && cropPlan.fallbackUsed === true ? 1 : 0;
  return cropPlan.mode === "soft_follow" || cropPlan.fallbackUsed === true ? 1 : 0;
}

function renderStylePresetIsValid(plan) {
  return Boolean(plan && RENDER_STYLE_PRESETS.includes(plan.stylePreset));
}

function planHasGoalLanguage(plan) {
  if (!plan || typeof plan !== "object") return false;
  const captionTexts = Array.isArray(plan.captions) ? plan.captions.map((caption) => caption.text) : [];
  const text = [plan.hook, ...captionTexts].filter(Boolean).join(" ");
  return hasGoalLanguage(text);
}

function framingIsSafe(plan, metadata = {}) {
  if (!plan || typeof plan !== "object") return false;
  if (!["wide_safe", "wide_safe_vertical", "safe_center", "action_bias"].includes(plan.framingMode)) return false;
  const crop = plan.cropStrategy;
  const cropPlan = cropPlanForPlan(plan, metadata);
  if (!crop || typeof crop !== "object") return false;
  const inputWidth = Math.max(1, toNumber(metadata.width, 1920));
  const inputHeight = Math.max(1, toNumber(metadata.height, 1080));
  const zoom = toNumber(crop.zoom, 1);
  if (!Number.isFinite(zoom) || zoom < 0.5 || zoom > 1.35) return false;
  if (["wide_safe", "wide_safe_vertical"].includes(plan.framingMode) && crop.preserveFullFrame !== true && !(cropPlan && cropPlan.mode === "soft_follow")) return false;
  if (crop.maxCropPercent !== undefined && toNumber(crop.maxCropPercent, 1) > 0.35) return false;
  if (crop.bounds && typeof crop.bounds === "object") {
    const left = toNumber(crop.bounds.left, Number.NaN);
    const top = toNumber(crop.bounds.top, Number.NaN);
    const width = toNumber(crop.bounds.width, Number.NaN);
    const height = toNumber(crop.bounds.height, Number.NaN);
    if (![left, top, width, height].every(Number.isFinite)) return false;
    if (left < 0 || top < 0 || width <= 0 || height <= 0) return false;
    if (left + width > inputWidth + 1 || top + height > inputHeight + 1) return false;
  }
  return true;
}

function animationCuesAreValid(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.animationCues) || plan.animationCues.length === 0) return false;
  const duration = Array.isArray(plan.segments) && plan.segments.length > 1
    ? toNumber(plan.totalDuration, toNumber(plan.sourceEnd) - toNumber(plan.sourceStart))
    : toNumber(plan.sourceEnd) - toNumber(plan.sourceStart);
  return plan.animationCues.every((cue) => {
    const start = toNumber(cue.start, Number.NaN);
    const end = toNumber(cue.end, Number.NaN);
    return (
      cue &&
      typeof cue.type === "string" &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start >= 0 &&
      end > start &&
      end <= duration + 0.25
    );
  });
}

function animationCueRelevanceScore(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.animationCues) || !Array.isArray(plan.reasonCodes)) return 0;
  const cueTypes = new Set(plan.animationCues.map((cue) => cue && cue.type).filter(Boolean));
  const reasonSet = new Set(plan.reasonCodes);
  const actionTypes = new Set([
    "goal",
    "shot_on_target",
    "near_miss",
    "big_chance",
    "save",
    "foul",
    "hard_foul",
    "counter_attack",
    "skill_move",
  ]);
  const actionReasons = [
    "big_chance",
    "shot_on_target",
    "save",
    "foul",
    "hard_foul",
    "counter_attack",
    "skill_move",
    "visual_shot_like_motion",
    "visual_shot_contact",
    "visual_ball_toward_goal",
    "visual_save_like_motion",
    "visual_keeper_action",
    "visual_foul_like_contact",
    "visual_fast_break",
  ];
  const impactReasons = [
    "goal",
    "save",
    "foul",
    "hard_foul",
    "visual_shot_contact",
    "visual_ball_in_net",
    "visual_save_like_motion",
    "visual_keeper_action",
    "visual_foul_like_contact",
  ];
  const reactionReasons = [
    "audio_energy_spike",
    "audio_peak",
    "commentator_peak",
    "crowd_reaction",
    "crowd_spike",
    "visual_crowd_reaction",
  ];
  const hasActionEvidence = actionTypes.has(plan.highlightType) || actionReasons.some((reason) => reasonSet.has(reason));
  const hasImpactEvidence = ["goal", "save", "foul", "hard_foul"].includes(plan.highlightType) ||
    impactReasons.some((reason) => reasonSet.has(reason));
  const reactionOnly = reactionReasons.some((reason) => reasonSet.has(reason)) && !hasActionEvidence;
  if (reactionOnly && (cueTypes.has("punch_zoom") || cueTypes.has("impact_flash") || cueTypes.has("freeze_frame"))) return 0;
  if (!hasActionEvidence && cueTypes.has("punch_zoom")) return 0;
  if (!hasImpactEvidence && (cueTypes.has("impact_flash") || cueTypes.has("freeze_frame"))) return 0;
  if (hasActionEvidence && !cueTypes.has("subtle_camera_push")) return 0.75;
  return 1;
}

function frameExtractionFixtureSummary(fixture) {
  const value = fixture.frameExtraction || fixture.sampledFrames || null;
  if (!value || typeof value !== "object") {
    return { fallbackUsed: false, frameCount: 0 };
  }
  const summary = value.summary && typeof value.summary === "object" ? value.summary : {};
  return {
    fallbackUsed: Boolean(value.fallbackUsed),
    frameCount: toNumber(summary.frameCount ?? value.frameCount, 0),
  };
}

function scoreFixture(fixture) {
  validateFixture(fixture);
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(fixture.thresholds || {}) };
  const metadata = {
    durationSeconds: fixture.durationSeconds,
    width: fixture.mediaSignals.width || 1920,
    height: fixture.mediaSignals.height || 1080,
    hasAudio: fixture.mediaSignals.hasAudio !== false,
    goalSelectionMode: fixture.expected.goalSelectionMode,
  };
  let visualSignals = validateVisualSignals(
    fixture.visualSignals || fixture.mediaSignals.visualSignals || { providerMode: "fixture-none", fallbackUsed: true, windows: [] },
    metadata,
  );
  const scoreboardOcr = deterministicScoreboardOcr({
    metadata,
    frames: fixture.sampledFrames && Array.isArray(fixture.sampledFrames.frames) ? fixture.sampledFrames.frames : [],
    candidateWindows: fixture.mediaSignals.highMotionCandidates || [],
    mediaSignals: fixture.mediaSignals,
    visualSignals,
    scoreboardOcr: fixture.scoreboardOcr || fixture.ocrEvidence || fixture.scoreboardEvidence,
  });
  const ocrQaCalibration = fixture.ocrQaCalibration
    ? publicOcrQaCalibration({ schemaVersion: 1, ...fixture.ocrQaCalibration })
    : defaultOcrQaCalibration("missing");
  const goalEvidence = deterministicGoalEvidence({
    metadata,
    transcript: fixture.transcript,
    mediaSignals: fixture.mediaSignals,
    visualSignals,
    ocrEvidence: scoreboardOcr.evidence,
    ocrQaCalibration,
  });
  visualSignals = mergeGoalEvidenceIntoVisualSignals(visualSignals, goalEvidence, metadata);
  const matchEventTruth = analyzeMatchEventTruth({
    metadata,
    transcript: fixture.transcript,
    mediaSignals: fixture.mediaSignals,
    visualSignals,
    goalEvidence,
    scoreboardOcr: scoreboardOcr.evidence,
    ocrQaCalibration,
  });
  const trackingProviderOutput = publicTrackingProviderOutput(
    fixture.trackingProviderOutput || analyzeTracking({
      metadata,
      visualSignals,
      mediaSignals: fixture.mediaSignals,
      frames: fixture.sampledFrames && Array.isArray(fixture.sampledFrames.frames) ? fixture.sampledFrames.frames : [],
    }),
    metadata,
  );
  const visualTracking = analyzeVisualTracking({
    metadata,
    visualSignals,
    mediaSignals: fixture.mediaSignals,
    trackingProviderOutput,
    visualTracking: fixture.visualTracking,
    frames: fixture.sampledFrames && Array.isArray(fixture.sampledFrames.frames) ? fixture.sampledFrames.frames : [],
  });
  const highlightResult = detectHighlights({
    transcript: fixture.transcript,
    signals: fixture.mediaSignals,
    visualSignals,
    goalEvidence,
    matchEventTruth,
    preset: fixture.expected.preset || "hype",
  });
  const candidatePlans = createCandidateEditPlans({
    moments: highlightResult.moments,
    metadata,
    transcript: fixture.transcript,
    mediaSignals: fixture.mediaSignals,
    visualSignals,
    goalEvidence,
    matchEventTruth,
    visualTracking,
    title: fixture.title,
    preset: fixture.expected.preset || "hype",
    language: fixture.language,
    styleTarget: fixture.expected.styleTarget || "vertical_9_16",
    editIntensity: fixture.expected.editIntensity || "balanced",
    stylePreset: fixture.expected.stylePreset || "social_sports_v1",
  });
  const topPlan = candidatePlans[0] || null;
  const rawTopMoment = highlightResult.moments[0] || null;
  const topMoment = fixture.expected.goalSelectionMode === "valid_goals_only"
    ? scoringMomentForValidGoalsOnly(topPlan, rawTopMoment)
    : rawTopMoment;
  const top1Overlap = topMoment ? bestOverlap(topMoment, fixture.expected.highlights) : 0;
  const recall = expectedValidGoalWindows(fixture.expected).length
    ? validGoalRecallScore(topPlan, fixture.expected, thresholds.minTop1Overlap)
    : top3Recall(highlightResult.moments, fixture.expected.highlights, thresholds.minTop1Overlap);
  const expectedReasonCodes = expectedReasonCodesForScoring(fixture.expected);
  const reasonPrecision = reasonCodePrecision(topMoment ? topMoment.reasonCodes : [], expectedReasonCodes);
  const reasonRecall = reasonCodeRecall(topMoment ? topMoment.reasonCodes : [], expectedReasonCodes);
  const expectedVisualReasons = visualReasonCodes(expectedReasonCodes);
  const actualVisualReasons = visualReasonCodes(topMoment ? topMoment.reasonCodes : []);
  const visualReasonPrecision = expectedVisualReasons.length ? reasonCodePrecision(actualVisualReasons, expectedVisualReasons) : 1;
  const visualReasonRecall = expectedVisualReasons.length ? reasonCodeRecall(actualVisualReasons, expectedVisualReasons) : 1;
  const retentionScore = topMoment ? toNumber(topMoment.retentionScore) : 0;
  const retentionSanity = retentionScore >= thresholds.minRetentionScore ? 1 : Math.max(0, retentionScore / thresholds.minRetentionScore);
  const expectedAspectRatio = fixture.expected.aspectRatio || "9:16";
  const candidatePlanValidity = candidatePlans.length > 0 &&
    candidatePlans.every((plan) => plan.aspectRatio === expectedAspectRatio && plan.export.format === "mp4")
    ? 1
    : 0;
  const captionTimingValidity = candidatePlans.every(captionsHaveValidTiming) ? 1 : 0;
  const captionRoleValidity = candidatePlans.every(captionsHaveValidRoles) ? 1 : 0;
  const captionEvidenceMetadataCompleteness = candidatePlans.every(captionEvidenceMetadataIsComplete) ? 1 : 0;
  const captionActionAlignment = topPlan ? captionActionAlignmentScore(topPlan) : 0;
  const genericCaptionPenaltyRate = topPlan ? genericCaptionPenalty(topPlan) : 0;
  const captionSpecificityScoreValue = topPlan ? captionSpecificityScore(topPlan) : 0;
  const reactionAsSupportScoreValue = topPlan ? reactionAsSupportScore(topPlan) : 0;
  const weakEvidenceNeutralityScoreValue = topPlan ? weakEvidenceNeutralityScore(topPlan) : 0;
  const providerFallbackRate = topPlan ? captionProviderFallbackRate(topPlan) : 0;
  const goalSequenceRecall = goalSequenceRecallScore(topMoment, topPlan, fixture.expected);
  const reactionAsSupportNotMain = reactionAsSupportScoreValue;
  const actionWindowCoverage = actionWindowCoverageScore(topMoment, fixture.expected.highlights);
  const shotToPayoffCoverage = shotToPayoffCoverageScore(topPlan, fixture.expected);
  const offsideOutcomeAccuracy = offsideOutcomeAccuracyScore(topPlan, fixture.expected);
  const disallowedGoalIncluded = disallowedGoalIncludedScore(topPlan, fixture.expected);
  const decisionContextCoverage = decisionContextCoverageScore(topMoment, topPlan, fixture.expected);
  const captionOutcomeAlignment = captionOutcomeAlignmentScore(topPlan, fixture.expected);
  const postGoalWindowCoverage = postGoalWindowCoverageScore(topMoment, fixture.expected);
  const validGoalRecall = validGoalRecallScore(topPlan, fixture.expected, thresholds.minTop1Overlap);
  const lateGoalRecall = lateGoalRecallScore(topPlan, fixture.expected, metadata.durationSeconds, thresholds.minTop1Overlap);
  const falseGoalRate = falseGoalRateScore(topPlan, fixture.expected, thresholds.minTop1Overlap);
  const offsideExclusionAccuracy = offsideExclusionAccuracyForValidGoals(topPlan, fixture.expected, thresholds.minTop1Overlap);
  const noGoalExclusionAccuracy = noGoalExclusionAccuracyForValidGoals(topPlan, fixture.expected, thresholds.minTop1Overlap);
  const validGoalsOnlyCoverage = validGoalsOnlyCoverageScore(topPlan, fixture.expected, thresholds.minTop1Overlap);
  const validGoalOnlyFillerRateValue = validGoalOnlyFillerRate(topPlan, fixture.expected);
  const validGoalsOnlyExactSegmentCount = validGoalsOnlyExactSegmentCountScore(topPlan, fixture.expected);
  const validGoalOrdering = validGoalOrderingScore(topPlan, fixture.expected, thresholds.minTop1Overlap);
  const fillerRate = validGoalOnlyFillerRateValue;
  const cutSmoothness = cutSmoothnessScore(topPlan, fixture.expected);
  const captionGoalClaimAccuracy = captionGoalClaimAccuracyScore(topPlan, fixture.expected);
  const segmentTimingCoverage = segmentTimingCoverageScore(topPlan, fixture.expected);
  const goalPhaseCoverage = goalPhaseCoverageScore(topPlan, fixture.expected);
  const replayOnlyGoalRateValue = replayOnlyGoalRate(topPlan, fixture.expected);
  const visualPolishScoreValue = referenceVisualPolishScore(topPlan, fixture.expected);
  const abruptCutRiskCountValue = abruptCutRiskCount(topPlan, fixture.expected);
  const goalEvidenceCoverage = goalEvidenceCoverageScore(goalEvidence, fixture.expected);
  const celebrationOnlyExclusion = celebrationOnlyExclusionScore(topPlan, fixture.expected, thresholds.minTop1Overlap);
  const anthemIntroExclusion = anthemIntroExclusionScore(topPlan, fixture.expected, thresholds.minTop1Overlap);
  const ocrEvidenceCoverage = ocrEvidenceCoverageScore(scoreboardOcr, fixture.expected);
  const scoreboardScoreChangeRecall = scoreboardScoreChangeRecallScore(scoreboardOcr, fixture.expected);
  const ambiguousOcrFailClosed = ambiguousOcrFailClosedScore(goalEvidence, fixture.expected);
  const noFalseGoalFromOcrOnly = noFalseGoalFromOcrOnlyScore(goalEvidence, fixture.expected);
  const ocrQaCalibrationSupport = ocrQaCalibrationSupportScore(goalEvidence, fixture.expected);
  const matchEventTruthValidGoalRecall = matchEventTruthValidGoalRecallScore(matchEventTruth, fixture.expected, thresholds.minTop1Overlap);
  const matchEventTruthLateGoalRecall = matchEventTruthLateGoalRecallScore(matchEventTruth, fixture.expected, metadata.durationSeconds, thresholds.minTop1Overlap);
  const matchEventTruthDisallowedClassification = matchEventTruthDisallowedClassificationScore(matchEventTruth, fixture.expected, thresholds.minTop1Overlap);
  const matchEventTruthFalseGoalRate = matchEventTruthFalseGoalRateScore(matchEventTruth, fixture.expected, thresholds.minTop1Overlap);
  const matchEventTruthAnchorContract = matchEventTruthAnchorContractScore(matchEventTruth, fixture.expected);
  const ballPlayerVisibilityScoreValue = ballPlayerVisibilityScore(topPlan);
  const cropSafetyScoreValue = cropSafetyScore(topPlan, metadata);
  const actionSafeZoneCoverage = actionSafeZoneCoverageScore(topPlan, metadata);
  const textObstructionRisk = textObstructionRiskValue(topPlan, metadata);
  const wideSafeFallback = wideSafeFallbackRate(topPlan, metadata);
  const trackingConfidenceCalibration = trackingConfidenceCalibrationScore(topPlan, fixture.expected, metadata);
  const trackingOutputValidity = trackingOutputValidityScore(trackingProviderOutput, metadata);
  const ballTrackCoverage = ballTrackCoverageScore(trackingProviderOutput, fixture.expected, metadata);
  const playerClusterCoverage = playerClusterCoverageScore(trackingProviderOutput, fixture.expected, metadata);
  const softFollowPrecision = softFollowPrecisionScore(topPlan, visualTracking);
  const wideSafeFallbackCorrectness = wideSafeFallbackCorrectnessScore(topPlan, fixture.expected);
  const falseGoalFromTrackingRate = visualTracking && visualTracking.goalClaimAllowed ? 1 : 0;
  const referenceStyleSimilarity = referenceStyleSimilarityScore(topPlan);
  const renderStylePresetValidity = candidatePlans.every(renderStylePresetIsValid) ? 1 : 0;
  const unsupportedCueCount = topPlan && Array.isArray(topPlan.unsupportedAnimationCues) ? topPlan.unsupportedAnimationCues.length : 0;
  const animationCueCount = topPlan && Array.isArray(topPlan.animationCues) ? topPlan.animationCues.length : 0;
  const unsupportedCueRate = round(unsupportedCueCount / Math.max(1, unsupportedCueCount + animationCueCount), 4);
  const unsupportedCueScore = unsupportedCueRate <= 0.25 ? 1 : Math.max(0, 1 - unsupportedCueRate);
  const expectedHighlightType = fixture.expected.highlightType || null;
  const highlightTypeAccuracy = expectedHighlightType && topMoment ? (topMoment.highlightType === expectedHighlightType ? 1 : 0) : 1;
  const falseGoalCaption = expectedHighlightType !== "goal" && planHasGoalLanguage(topPlan) ? 1 : 0;
  const topGoalOutcome = topMoment &&
    topMoment.evidence &&
    topMoment.evidence.goalOutcome &&
    topMoment.evidence.goalOutcome.eventType === "ball_in_net"
    ? topMoment.evidence.goalOutcome
    : null;
  const falseVisualGoal = topMoment &&
    topMoment.highlightType === "goal" &&
    !topMoment.reasonCodes.includes("goal") &&
    actualVisualReasons.length > 0 &&
    !(topGoalOutcome && topGoalOutcome.outcome !== "confirmed_goal")
    ? 1
    : 0;
  const falseGoalCaptionRate = falseGoalCaption;
  const falseVisualGoalRate = falseVisualGoal;
  const captionSafety = falseGoalCaption ? 0 : 1;
  const framingSafety = topPlan && framingIsSafe(topPlan, metadata) ? 1 : 0;
  const animationCueValidity = topPlan && animationCuesAreValid(topPlan) ? 1 : 0;
  const animationCueRelevance = topPlan ? animationCueRelevanceScore(topPlan) : 0;
  const fallbackUsed = Boolean(highlightResult.fallback);
  const visualFallbackUsed = Boolean(visualSignals.fallbackUsed);
  const frameExtraction = frameExtractionFixtureSummary(fixture);
  const frameExtractionFallbackUsed = frameExtraction.fallbackUsed;
  const fallbackScore = fallbackUsed ? 0 : 1;
  const weightedScore = Math.min(100, Math.round(
    scoreToPercent(top1Overlap) * 0.14 +
      scoreToPercent(recall) * 0.11 +
      scoreToPercent(reasonPrecision) * 0.09 +
      scoreToPercent(reasonRecall) * 0.07 +
      scoreToPercent(highlightTypeAccuracy) * 0.1 +
      scoreToPercent(captionSafety) * 0.08 +
      scoreToPercent(framingSafety) * 0.05 +
      scoreToPercent(animationCueValidity) * 0.03 +
      scoreToPercent(animationCueRelevance) * 0.03 +
      scoreToPercent(retentionSanity) * 0.03 +
      scoreToPercent(candidatePlanValidity) * 0.03 +
      scoreToPercent(captionTimingValidity) * 0.03 +
      scoreToPercent(fallbackScore) * 0.02 +
      scoreToPercent(captionRoleValidity) * 0.03 +
      scoreToPercent(renderStylePresetValidity) * 0.02 +
      scoreToPercent(unsupportedCueScore) * 0.02 +
      scoreToPercent(captionSpecificityScoreValue) * 0.06 +
      scoreToPercent(reactionAsSupportScoreValue) * 0.04 +
      scoreToPercent(weakEvidenceNeutralityScoreValue) * 0.04,
  ));
  const passed =
    weightedScore >= thresholds.minAggregateScore &&
    top1Overlap >= thresholds.minTop1Overlap &&
    recall >= thresholds.minTop3Recall &&
    reasonPrecision >= thresholds.minReasonPrecision &&
    visualReasonPrecision >= thresholds.minReasonPrecision &&
    candidatePlanValidity === 1 &&
    captionTimingValidity === 1 &&
    captionRoleValidity === 1 &&
    captionEvidenceMetadataCompleteness === 1 &&
    captionActionAlignment === 1 &&
    genericCaptionPenaltyRate === 0 &&
    captionSpecificityScoreValue >= 0.75 &&
    reactionAsSupportScoreValue >= 0.75 &&
    weakEvidenceNeutralityScoreValue >= 0.75 &&
    renderStylePresetValidity === 1 &&
    unsupportedCueRate <= 0.25 &&
    highlightTypeAccuracy === 1 &&
    captionSafety === 1 &&
    falseVisualGoalRate === 0 &&
    framingSafety === 1 &&
    cropSafetyScoreValue === 1 &&
    actionSafeZoneCoverage >= 0.95 &&
    textObstructionRisk === 0 &&
    trackingConfidenceCalibration >= 0.9 &&
    trackingOutputValidity === 1 &&
    ballTrackCoverage === 1 &&
    playerClusterCoverage === 1 &&
    softFollowPrecision === 1 &&
    wideSafeFallbackCorrectness === 1 &&
    falseGoalFromTrackingRate === 0 &&
    animationCueValidity === 1 &&
    animationCueRelevance >= 0.95 &&
    offsideOutcomeAccuracy >= 0.9 &&
    disallowedGoalIncluded === 1 &&
    decisionContextCoverage >= 0.9 &&
    captionOutcomeAlignment >= 0.95 &&
    postGoalWindowCoverage >= 0.9 &&
    validGoalRecall >= 1 &&
    lateGoalRecall >= 1 &&
    falseGoalRate === 0 &&
    offsideExclusionAccuracy === 1 &&
    noGoalExclusionAccuracy === 1 &&
    validGoalsOnlyCoverage >= 1 &&
    validGoalOnlyFillerRateValue === 0 &&
    validGoalsOnlyExactSegmentCount === 1 &&
    validGoalOrdering === 1 &&
    fillerRate === 0 &&
    cutSmoothness >= 0.9 &&
    celebrationOnlyExclusion === 1 &&
    anthemIntroExclusion === 1 &&
    captionGoalClaimAccuracy >= 0.95 &&
    segmentTimingCoverage >= 0.9 &&
    goalPhaseCoverage >= 1 &&
    replayOnlyGoalRateValue === 0 &&
    visualPolishScoreValue >= 0.95 &&
    abruptCutRiskCountValue === 0 &&
    goalEvidenceCoverage >= 1 &&
    ocrEvidenceCoverage >= 0.9 &&
    scoreboardScoreChangeRecall >= 0.9 &&
    ambiguousOcrFailClosed === 1 &&
    noFalseGoalFromOcrOnly === 1 &&
    ocrQaCalibrationSupport === 1 &&
    matchEventTruthValidGoalRecall >= 1 &&
    matchEventTruthLateGoalRecall >= 1 &&
    matchEventTruthDisallowedClassification >= 1 &&
    matchEventTruthFalseGoalRate === 0 &&
    matchEventTruthAnchorContract >= 1;

  return {
    id: fixture.id,
    title: sanitizeReportText(fixture.title, 160),
    language: sanitizeReportText(fixture.language, 40),
    passed,
    score: weightedScore,
    thresholds,
    metrics: {
      top1Overlap,
      top3Recall: recall,
      reasonCodePrecision: reasonPrecision,
      reasonCodeRecall: reasonRecall,
      visualReasonPrecision,
      visualReasonRecall,
      visualLabelPrecision: visualReasonPrecision,
      visualLabelRecall: visualReasonRecall,
      retentionScore,
      retentionSanity: round(retentionSanity, 4),
      candidatePlanValidity,
      captionTimingValidity,
      captionRoleValidity,
      captionEvidenceMetadataCompleteness,
      captionActionAlignment,
      genericCaptionPenaltyRate,
      captionSpecificityScore: captionSpecificityScoreValue,
      reactionAsSupportScore: reactionAsSupportScoreValue,
      weakEvidenceNeutralityScore: weakEvidenceNeutralityScoreValue,
      providerFallbackRate,
      goalSequenceRecall,
      offsideOutcomeAccuracy,
      disallowedGoalIncluded,
      decisionContextCoverage,
      captionOutcomeAlignment,
      postGoalWindowCoverage,
      validGoalRecall,
      lateGoalRecall,
      falseGoalRate,
      offsideExclusionAccuracy,
      noGoalExclusionAccuracy,
      validGoalsOnlyCoverage,
      validGoalOnlyFillerRate: validGoalOnlyFillerRateValue,
      validGoalsOnlyExactSegmentCount,
      validGoalOrdering,
      fillerRate,
      cutSmoothnessScore: cutSmoothness,
      captionGoalClaimAccuracy,
      segmentTimingCoverage,
      goalPhaseCoverage,
      replayOnlyGoalRate: replayOnlyGoalRateValue,
      visualPolishScore: visualPolishScoreValue,
      abruptCutRiskCount: abruptCutRiskCountValue,
      goalEvidenceCoverage,
      celebrationOnlyExclusion,
      anthemIntroExclusion,
      ocrEvidenceCoverage,
      scoreboardScoreChangeRecall,
      ambiguousOcrFailClosed,
      noFalseGoalFromOcrOnly,
      ocrQaCalibrationSupport,
      matchEventTruthValidGoalRecall,
      matchEventTruthLateGoalRecall,
      matchEventTruthDisallowedClassification,
      matchEventTruthFalseGoalRate,
      matchEventTruthAnchorContract,
      reactionAsSupportNotMain,
      actionWindowCoverage,
      shotToPayoffCoverage,
      ballPlayerVisibilityScore: ballPlayerVisibilityScoreValue,
      cropSafetyScore: cropSafetyScoreValue,
      actionSafeZoneCoverage,
      textObstructionRisk,
      wideSafeFallbackRate: wideSafeFallback,
      trackingConfidenceCalibration,
      trackingOutputValidity,
      ballTrackCoverage,
      playerClusterCoverage,
      softFollowPrecision,
      wideSafeFallbackCorrectness,
      falseGoalFromTrackingRate,
      referenceStyleSimilarity,
      renderStylePresetValidity,
      unsupportedCueRate,
      highlightTypeAccuracy,
      falseGoalCaptionRate,
      falseVisualGoalRate,
      captionSafety,
      framingSafety,
      animationCueValidity,
      animationCueRelevance,
      fallbackUsed,
      visualFallbackUsed,
      frameExtractionFallbackUsed,
      sampledFrameCount: frameExtraction.frameCount,
      goalEvidenceProviderMode: goalEvidence.providerMode,
      goalEvidenceEventCount: goalEvidence.summary.eventCount,
      scoreboardOcrProviderMode: scoreboardOcr.providerMode,
      scoreboardOcrEvidenceCount: scoreboardOcr.summary.evidenceCount,
      ocrQaStatus: goalEvidence.summary.ocrQaStatus,
      ocrQaUsable: goalEvidence.summary.ocrQaUsable,
      ocrQaSupportLevel: goalEvidence.summary.ocrQaSupportLevel,
    },
    expected: {
      highlights: fixture.expected.highlights.map((item) => ({ start: item.start, end: item.end })),
      reasonCodes: [...expectedReasonCodes],
      highlightType: expectedHighlightType,
      stylePreset: fixture.expected.stylePreset,
      styleTarget: fixture.expected.styleTarget || "vertical_9_16",
      aspectRatio: expectedAspectRatio,
      cropMode: fixture.expected.cropMode || fixture.expected.expectedCropMode || null,
    },
    actual: {
      topMoment: topMoment
        ? {
            start: topMoment.start,
            end: topMoment.end,
            retentionScore: topMoment.retentionScore,
            reasonCodes: topMoment.reasonCodes,
            highlightType: topMoment.highlightType,
            visualEvidence: topMoment.evidence && topMoment.evidence.visual
              ? {
                  windowCount: topMoment.evidence.visual.windowCount,
                  topTypes: topMoment.evidence.visual.topTypes,
                  actionFocusConfidence: topMoment.evidence.visual.actionFocusConfidence,
                  goalClaimAllowed: false,
                }
              : null,
            goalEvidence: topMoment.evidence && topMoment.evidence.goalEvidence
              ? {
                  evidenceLevel: sanitizeReportText(topMoment.evidence.goalEvidence.evidenceLevel, 24),
                  confidence: topMoment.evidence.goalEvidence.confidence,
                  goalClaimAllowed: Boolean(topMoment.evidence.goalEvidence.goalClaimAllowed),
                  hasShotContact: Boolean(topMoment.evidence.goalEvidence.hasShotContact),
                  hasBallTowardGoal: Boolean(topMoment.evidence.goalEvidence.hasBallTowardGoal),
                  hasGoalMouthFrame: Boolean(topMoment.evidence.goalEvidence.hasGoalMouthFrame),
                  hasBallInNetOrLineCross: Boolean(topMoment.evidence.goalEvidence.hasBallInNetOrLineCross),
                  hasCelebrationAfterShot: Boolean(topMoment.evidence.goalEvidence.hasCelebrationAfterShot),
                }
              : null,
            goalOutcome: topMoment.evidence && topMoment.evidence.goalOutcome
              ? {
                  outcome: sanitizeReportText(topMoment.evidence.goalOutcome.outcome, 40),
                  offsideStatus: sanitizeReportText(topMoment.evidence.goalOutcome.offsideStatus, 32),
                  decisionTimestamp: topMoment.evidence.goalOutcome.decisionTimestamp,
                  decisionEvidence: Array.isArray(topMoment.evidence.goalOutcome.decisionEvidence)
                    ? topMoment.evidence.goalOutcome.decisionEvidence.map((item) => sanitizeReportText(item, 64)).slice(0, 12)
                    : [],
                  decisionWindow: topMoment.evidence.goalOutcome.decisionWindow || null,
                  safeCaptionBadge: sanitizeReportText(topMoment.evidence.goalOutcome.safeCaptionBadge, 40),
                  requiresPostContext: Boolean(topMoment.evidence.goalOutcome.requiresPostContext),
                }
              : null,
            source: topMoment.source,
          }
        : null,
      rawTopMoment: rawTopMoment && rawTopMoment !== topMoment
        ? {
            start: rawTopMoment.start,
            end: rawTopMoment.end,
            retentionScore: rawTopMoment.retentionScore,
            reasonCodes: rawTopMoment.reasonCodes,
            highlightType: rawTopMoment.highlightType,
            source: rawTopMoment.source,
            goalOutcome: rawTopMoment.evidence && rawTopMoment.evidence.goalOutcome
              ? {
                  outcome: sanitizeReportText(rawTopMoment.evidence.goalOutcome.outcome, 40),
                  offsideStatus: sanitizeReportText(rawTopMoment.evidence.goalOutcome.offsideStatus, 32),
                }
              : null,
          }
        : null,
      goalEvidence: {
        providerMode: sanitizeReportText(goalEvidence.providerMode, 60),
        eventCount: goalEvidence.summary.eventCount,
        validGoalCount: goalEvidence.summary.validGoalCount,
        offsideOrNoGoalCount: goalEvidence.summary.offsideOrNoGoalCount,
        unconfirmedGoalCount: goalEvidence.summary.unconfirmedGoalCount,
        nonGoalChanceCount: goalEvidence.summary.nonGoalChanceCount,
        celebrationOnlyCount: goalEvidence.summary.celebrationOnlyCount,
        anthemOrIntroCount: goalEvidence.summary.anthemOrIntroCount,
        ocrEvidenceCount: goalEvidence.summary.ocrEvidenceCount,
        scoreboardConfirmedGoalCount: goalEvidence.summary.scoreboardConfirmedGoalCount,
        ambiguousOcrCount: goalEvidence.summary.ambiguousOcrCount,
        goalEvidenceCoverage: goalEvidence.summary.goalEvidenceCoverage,
        ocrQaCalibration: goalEvidence.ocrQaCalibration,
      },
      matchEventTruth: publicMatchEventTruth(matchEventTruth),
      scoreboardOcr: {
        providerMode: sanitizeReportText(scoreboardOcr.providerMode, 60),
        fallbackUsed: Boolean(scoreboardOcr.fallbackUsed),
        evidenceCount: scoreboardOcr.summary.evidenceCount,
        scoreChangeCount: scoreboardOcr.summary.scoreChangeCount,
        scoreUnchangedCount: scoreboardOcr.summary.scoreUnchangedCount,
        ambiguousCount: scoreboardOcr.summary.ambiguousCount,
        clockOnlyCount: scoreboardOcr.summary.clockOnlyCount,
        unreadableCount: scoreboardOcr.summary.unreadableCount,
        sampledFrameCount: scoreboardOcr.summary.sampledFrameCount,
      },
      candidatePlans: candidatePlans.map((plan) => ({
        rank: plan.rank,
        mode: plan.mode || "single_moment",
        goalSelectionMode: sanitizeReportText(plan.goalSelectionMode, 40),
        sourceStart: plan.sourceStart,
        sourceEnd: plan.sourceEnd,
        totalDuration: plan.totalDuration,
        selectedMomentCount: Array.isArray(plan.segments) && plan.segments.length ? plan.segments.length : 1,
        segments: Array.isArray(plan.segments)
          ? plan.segments.map((segment) => ({
              sourceStart: segment.sourceStart,
              sourceEnd: segment.sourceEnd,
              timelineStart: segment.timelineStart,
              timelineEnd: segment.timelineEnd,
              highlightType: segment.highlightType,
              reasonCodes: segment.reasonCodes,
              goalOutcome: segment.goalOutcome && segment.goalOutcome.eventType === "ball_in_net"
                ? {
                    outcome: sanitizeReportText(segment.goalOutcome.outcome, 40),
                    offsideStatus: sanitizeReportText(segment.goalOutcome.offsideStatus, 32),
                    decisionTimestamp: segment.goalOutcome.decisionTimestamp,
                    safeCaptionBadge: sanitizeReportText(segment.goalOutcome.safeCaptionBadge, 40),
                  }
                : null,
              whySelected: sanitizeReportText(segment.whySelected, 160),
              safetyFlags: Array.isArray(segment.safetyFlags) ? segment.safetyFlags : [],
            }))
          : [],
        retentionScore: plan.retentionScore,
        reasonCodes: plan.reasonCodes,
        highlightType: plan.highlightType,
        goalOutcome: plan.goalOutcome && plan.goalOutcome.eventType === "ball_in_net"
          ? {
              outcome: sanitizeReportText(plan.goalOutcome.outcome, 40),
              offsideStatus: sanitizeReportText(plan.goalOutcome.offsideStatus, 32),
              decisionTimestamp: plan.goalOutcome.decisionTimestamp,
              decisionEvidence: Array.isArray(plan.goalOutcome.decisionEvidence)
                ? plan.goalOutcome.decisionEvidence.map((item) => sanitizeReportText(item, 64)).slice(0, 12)
                : [],
              decisionWindow: plan.goalOutcome.decisionWindow || null,
              safeCaptionBadge: sanitizeReportText(plan.goalOutcome.safeCaptionBadge, 40),
            }
          : null,
        stylePreset: plan.stylePreset,
        styleTarget: plan.styleTarget,
        editIntensity: plan.editIntensity,
        aspectRatio: plan.aspectRatio,
        storyType: plan.footballStoryPlan && plan.footballStoryPlan.storyType,
        framingMode: plan.framingMode,
        framingReason: plan.framingReason,
        actionFocusConfidence: plan.actionFocusConfidence,
        visualEvidenceSummary: plan.visualEvidenceSummary,
        visualTrackingSummary: plan.visualTrackingSummary,
        cropPlan: plan.cropPlan
          ? {
              mode: plan.cropPlan.mode,
              confidence: plan.cropPlan.confidence,
              fallbackUsed: plan.cropPlan.fallbackUsed,
              reasonCodes: plan.cropPlan.reasonCodes,
              textObstructionRisk: Boolean(plan.cropPlan.textObstructionRisk),
              actionSafeZoneCount: Array.isArray(plan.cropPlan.actionSafeZones) ? plan.cropPlan.actionSafeZones.length : 0,
            }
          : null,
        visualQA: plan.visualQA || (plan.reviewMetadata && plan.reviewMetadata.visualQA) || null,
        visualPolishQA: plan.visualPolishQA || (
          plan.reviewMetadata &&
          plan.reviewMetadata.multiMoment &&
          plan.reviewMetadata.multiMoment.visualPolishQA
        ) || null,
        editAssembly: plan.editAssembly || (
          plan.reviewMetadata &&
          plan.reviewMetadata.multiMoment &&
          plan.reviewMetadata.multiMoment.editAssembly
        ) || null,
        actionSequenceSummary: plan.actionSequenceSummary || (
          plan.analysisMoment && plan.analysisMoment.actionSequenceSummary
        ) || null,
        animationCueCount: Array.isArray(plan.animationCues) ? plan.animationCues.length : 0,
        animationCueTypes: Array.isArray(plan.animationCues) ? [...new Set(plan.animationCues.map((cue) => cue.type).filter(Boolean))] : [],
        unsupportedAnimationCueCount: Array.isArray(plan.unsupportedAnimationCues) ? plan.unsupportedAnimationCues.length : 0,
        captions: plan.captions.length,
        captionRoles: plan.captions.map((caption) => caption.role),
        captionIntents: plan.captions.map((caption) => caption.captionIntent),
        captionSources: plan.captions.map((caption) => caption.captionSource),
        captionRiskFlags: plan.captions.flatMap((caption) => caption.captionRiskFlags || []),
        captionGeneration: plan.footballStoryPlan && plan.footballStoryPlan.captionGeneration,
        effects: plan.effects,
      })),
    },
    notes: debuggingNotes({
      top1Overlap,
      recall,
      reasonPrecision,
      visualReasonPrecision,
      retentionScore,
      candidatePlanValidity,
      captionTimingValidity,
      captionRoleValidity,
      captionEvidenceMetadataCompleteness,
      captionActionAlignment,
      genericCaptionPenaltyRate,
      captionSpecificityScore: captionSpecificityScoreValue,
      reactionAsSupportScore: reactionAsSupportScoreValue,
      weakEvidenceNeutralityScore: weakEvidenceNeutralityScoreValue,
      renderStylePresetValidity,
      unsupportedCueRate,
      highlightTypeAccuracy,
      captionSafety,
      falseVisualGoalRate,
      framingSafety,
      cropSafetyScore: cropSafetyScoreValue,
      actionSafeZoneCoverage,
      textObstructionRisk,
      trackingConfidenceCalibration,
      trackingOutputValidity,
      ballTrackCoverage,
      playerClusterCoverage,
      softFollowPrecision,
      wideSafeFallbackCorrectness,
      falseGoalFromTrackingRate,
      offsideOutcomeAccuracy,
      disallowedGoalIncluded,
      decisionContextCoverage,
      captionOutcomeAlignment,
      postGoalWindowCoverage,
      validGoalRecall,
      lateGoalRecall,
      falseGoalRate,
      offsideExclusionAccuracy,
      noGoalExclusionAccuracy,
      validGoalsOnlyCoverage,
      validGoalOnlyFillerRate: validGoalOnlyFillerRateValue,
      fillerRate,
      cutSmoothnessScore: cutSmoothness,
      captionGoalClaimAccuracy,
      segmentTimingCoverage,
      goalEvidenceCoverage,
      ocrQaCalibrationSupport,
      matchEventTruthValidGoalRecall,
      matchEventTruthLateGoalRecall,
      matchEventTruthDisallowedClassification,
      matchEventTruthFalseGoalRate,
      matchEventTruthAnchorContract,
      animationCueValidity,
      animationCueRelevance,
      fallbackUsed,
      frameExtractionFallbackUsed,
      thresholds,
    }),
  };
}

function debuggingNotes(metrics) {
  const notes = [];
  if (metrics.top1Overlap < metrics.thresholds.minTop1Overlap) notes.push("Top-ranked moment misses the expected highlight window.");
  if (metrics.recall < metrics.thresholds.minTop3Recall) notes.push("Top-3 ranking does not cover enough expected moments.");
  if (metrics.reasonPrecision < metrics.thresholds.minReasonPrecision) notes.push("Reason codes are noisy against expected labels.");
  if (metrics.visualReasonPrecision < metrics.thresholds.minReasonPrecision) notes.push("Visual reason codes are noisy against expected labels.");
  if (metrics.retentionScore < metrics.thresholds.minRetentionScore) notes.push("Retention score looks too weak for a highlight candidate.");
  if (!metrics.candidatePlanValidity) notes.push("Candidate edit plan validation failed.");
  if (!metrics.captionTimingValidity) notes.push("Caption timings are outside the selected source window.");
  if (!metrics.captionRoleValidity) notes.push("Kinetic caption role/style contract is missing or invalid.");
  if (!metrics.captionEvidenceMetadataCompleteness) notes.push("Caption evidence metadata is missing or incomplete.");
  if (!metrics.captionActionAlignment) notes.push("Caption copy does not align with the selected football action type.");
  if (metrics.genericCaptionPenaltyRate) notes.push("Action-led moment received generic crowd or pressure hype captions.");
  if (metrics.captionSpecificityScore < 0.75) notes.push("Caption is too generic for the selected football action.");
  if (metrics.reactionAsSupportScore < 0.75) notes.push("Crowd reaction is used as the primary copy despite stronger action evidence.");
  if (metrics.weakEvidenceNeutralityScore < 0.75) notes.push("Safe neutral caption was not used for uncertain moment.");
  if (!metrics.renderStylePresetValidity) notes.push("Candidate edit plan is missing a supported render style preset.");
  if (metrics.unsupportedCueRate > 0.25) notes.push("Too many animation cues were ignored as unsupported.");
  if (!metrics.highlightTypeAccuracy) notes.push("Top-ranked moment has the wrong football highlight type.");
  if (!metrics.captionSafety) notes.push("No-goal fixture received misleading goal language.");
  if (metrics.falseVisualGoalRate) notes.push("Visual signals created goal classification without explicit goal evidence.");
  if (!metrics.framingSafety) notes.push("Candidate edit plan is missing safe vertical framing metadata.");
  if (!metrics.cropSafetyScore) notes.push("Crop plan is unsafe or missing confidence-gated fallback behavior.");
  if (metrics.actionSafeZoneCoverage < 0.95) notes.push("Action bounds are not covered by the crop safe area.");
  if (metrics.textObstructionRisk) notes.push("Caption safe zones may overlap the likely action area.");
  if (metrics.trackingConfidenceCalibration < 0.9) notes.push("Tracking confidence does not match the selected crop mode.");
  if (!metrics.trackingOutputValidity) notes.push("Tracking provider output failed schema or safety validation.");
  if (!metrics.ballTrackCoverage) notes.push("Expected soft-follow crop does not have enough ball track evidence.");
  if (!metrics.playerClusterCoverage) notes.push("Expected soft-follow crop does not have enough player cluster evidence.");
  if (!metrics.softFollowPrecision) notes.push("Soft-follow crop was allowed without reliable ball/player tracking.");
  if (!metrics.wideSafeFallbackCorrectness) notes.push("Tracking fallback did not match the expected safe crop mode.");
  if (metrics.falseGoalFromTrackingRate) notes.push("Tracking metadata attempted to enable a goal claim.");
  if (!metrics.animationCueValidity) notes.push("Social edit animation cues are missing or invalid.");
  if (metrics.animationCueRelevance < 0.95) notes.push("Animation cues are not aligned with action/contact/payoff evidence.");
  if (metrics.offsideOutcomeAccuracy < 0.9) notes.push("Goal outcome/offside decision does not match expected decision evidence.");
  if (!metrics.disallowedGoalIncluded) notes.push("Disallowed goal evidence was dropped instead of included with a no-goal label.");
  if (metrics.decisionContextCoverage < 0.9) notes.push("Post-goal decision context is not covered by the selected moment and plan.");
  if (metrics.captionOutcomeAlignment < 0.95) notes.push("Captions do not align with the resolved goal outcome.");
  if (metrics.postGoalWindowCoverage < 0.9) notes.push("Ball-in-net moment does not keep enough post-goal decision window.");
  if (metrics.validGoalRecall < 1) notes.push("Valid-goals-only output missed one or more expected confirmed goals.");
  if (metrics.lateGoalRecall < 1) notes.push("Late confirmed goals were not fully covered.");
  if (metrics.falseGoalRate) notes.push("A confirmed-goal segment did not match an expected valid goal.");
  if (metrics.offsideExclusionAccuracy < 1) notes.push("An offside/disallowed goal was included as a valid goal.");
  if (metrics.noGoalExclusionAccuracy < 1) notes.push("A no-goal/disallowed segment was included as a valid goal.");
  if (metrics.validGoalsOnlyCoverage < 1) notes.push("Valid-goals-only output does not cleanly cover every confirmed goal.");
  if (metrics.validGoalOnlyFillerRate) notes.push("Valid-goals-only output includes non-goal filler.");
  if (metrics.validGoalsOnlyExactSegmentCount < 1) notes.push("Valid-goals-only output segment count does not equal the counted-goal truth count.");
  if (metrics.validGoalOrdering < 1) notes.push("Valid-goals-only output is not ordered exactly like the counted-goal truth sequence.");
  if (metrics.cutSmoothnessScore < 0.9) notes.push("Valid-goals-only cuts are overlapping, out of order, too short or too long.");
  if (metrics.captionGoalClaimAccuracy < 0.95) notes.push("Goal captions do not match valid-goal expectations.");
  if (metrics.segmentTimingCoverage < 0.9) notes.push("Goal segments do not cover the expected shot/payoff/decision window.");
  if (metrics.goalPhaseCoverage < 1) notes.push("Confirmed-goal segments do not cover buildup, shot, finish and confirmation.");
  if (metrics.replayOnlyGoalRate) notes.push("A confirmed-goal segment is replay-only.");
  if (metrics.visualPolishScore < 0.95) notes.push("Reference-style visual polish QA is missing or below threshold.");
  if (metrics.abruptCutRiskCount) notes.push("Reference-style QA detected abrupt cut risk.");
  if (metrics.goalEvidenceCoverage < 1) notes.push("Goal evidence provider did not cover all expected valid goals.");
  if (metrics.ocrQaCalibrationSupport < 1) notes.push("OCR QA calibration was not applied as support-only evidence.");
  if (metrics.matchEventTruthValidGoalRecall < 1) notes.push("Match event truth missed one or more expected confirmed goals.");
  if (metrics.matchEventTruthLateGoalRecall < 1) notes.push("Match event truth missed a late confirmed goal.");
  if (metrics.matchEventTruthDisallowedClassification < 1) notes.push("Match event truth did not classify an expected offside/no-goal event.");
  if (metrics.matchEventTruthFalseGoalRate) notes.push("Match event truth confirmed a false or offside goal.");
  if (metrics.matchEventTruthAnchorContract < 1) notes.push("Match event truth score-change anchor diagnostics do not match expected counted-goal contract.");
  if (metrics.fallbackUsed) notes.push("Analysis fell back to deterministic fallback moments.");
  if (metrics.frameExtractionFallbackUsed) notes.push("Sampled frame extraction fell back to deterministic frame metadata.");
  return notes;
}

function loadFixtures(fixturesDir) {
  const files = readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  return files.map((fileName) => {
    const raw = JSON.parse(readFileSync(join(fixturesDir, fileName), "utf8"));
    validateFixture(raw);
    return raw;
  });
}

function aggregateResults(results) {
  const count = results.length || 1;
  const avg = (selector) => round(results.reduce((sum, result) => sum + selector(result), 0) / count, 4);
  const aggregateScore = Math.round(results.reduce((sum, result) => sum + result.score, 0) / count);
  return {
    fixtureCount: results.length,
    aggregateScore,
    passRate: avg((result) => (result.passed ? 1 : 0)),
    top1Overlap: avg((result) => result.metrics.top1Overlap),
    top3Recall: avg((result) => result.metrics.top3Recall),
    reasonCodePrecision: avg((result) => result.metrics.reasonCodePrecision),
    reasonCodeRecall: avg((result) => result.metrics.reasonCodeRecall),
    visualReasonPrecision: avg((result) => result.metrics.visualReasonPrecision),
    visualReasonRecall: avg((result) => result.metrics.visualReasonRecall),
    visualLabelPrecision: avg((result) => result.metrics.visualLabelPrecision),
    visualLabelRecall: avg((result) => result.metrics.visualLabelRecall),
    highlightTypeAccuracy: avg((result) => result.metrics.highlightTypeAccuracy),
    falseGoalCaptionRate: avg((result) => result.metrics.falseGoalCaptionRate),
    falseVisualGoalRate: avg((result) => result.metrics.falseVisualGoalRate),
    captionSafety: avg((result) => result.metrics.captionSafety),
    framingSafety: avg((result) => result.metrics.framingSafety),
    animationCueValidity: avg((result) => result.metrics.animationCueValidity),
    animationCueRelevance: avg((result) => result.metrics.animationCueRelevance),
    captionRoleValidity: avg((result) => result.metrics.captionRoleValidity),
    captionEvidenceMetadataCompleteness: avg((result) => result.metrics.captionEvidenceMetadataCompleteness),
    captionActionAlignment: avg((result) => result.metrics.captionActionAlignment),
    genericCaptionPenaltyRate: avg((result) => result.metrics.genericCaptionPenaltyRate),
    captionSpecificityScore: avg((result) => result.metrics.captionSpecificityScore),
    reactionAsSupportScore: avg((result) => result.metrics.reactionAsSupportScore),
    reactionAsSupportNotMain: avg((result) => result.metrics.reactionAsSupportNotMain),
    weakEvidenceNeutralityScore: avg((result) => result.metrics.weakEvidenceNeutralityScore),
    providerFallbackRate: avg((result) => result.metrics.providerFallbackRate),
    goalSequenceRecall: avg((result) => result.metrics.goalSequenceRecall),
    offsideOutcomeAccuracy: avg((result) => result.metrics.offsideOutcomeAccuracy),
    disallowedGoalIncluded: avg((result) => result.metrics.disallowedGoalIncluded),
    decisionContextCoverage: avg((result) => result.metrics.decisionContextCoverage),
    captionOutcomeAlignment: avg((result) => result.metrics.captionOutcomeAlignment),
    postGoalWindowCoverage: avg((result) => result.metrics.postGoalWindowCoverage),
    validGoalRecall: avg((result) => result.metrics.validGoalRecall),
    lateGoalRecall: avg((result) => result.metrics.lateGoalRecall),
    falseGoalRate: avg((result) => result.metrics.falseGoalRate),
    offsideExclusionAccuracy: avg((result) => result.metrics.offsideExclusionAccuracy),
    noGoalExclusionAccuracy: avg((result) => result.metrics.noGoalExclusionAccuracy),
    validGoalsOnlyCoverage: avg((result) => result.metrics.validGoalsOnlyCoverage),
    validGoalOnlyFillerRate: avg((result) => result.metrics.validGoalOnlyFillerRate),
    validGoalsOnlyExactSegmentCount: avg((result) => result.metrics.validGoalsOnlyExactSegmentCount),
    validGoalOrdering: avg((result) => result.metrics.validGoalOrdering),
    fillerRate: avg((result) => result.metrics.fillerRate),
    cutSmoothnessScore: avg((result) => result.metrics.cutSmoothnessScore),
    captionGoalClaimAccuracy: avg((result) => result.metrics.captionGoalClaimAccuracy),
    segmentTimingCoverage: avg((result) => result.metrics.segmentTimingCoverage),
    goalPhaseCoverage: avg((result) => result.metrics.goalPhaseCoverage),
    replayOnlyGoalRate: avg((result) => result.metrics.replayOnlyGoalRate),
    visualPolishScore: avg((result) => result.metrics.visualPolishScore),
    abruptCutRiskCount: avg((result) => result.metrics.abruptCutRiskCount),
    goalEvidenceCoverage: avg((result) => result.metrics.goalEvidenceCoverage),
    celebrationOnlyExclusion: avg((result) => result.metrics.celebrationOnlyExclusion),
    anthemIntroExclusion: avg((result) => result.metrics.anthemIntroExclusion),
    ocrEvidenceCoverage: avg((result) => result.metrics.ocrEvidenceCoverage),
    scoreboardScoreChangeRecall: avg((result) => result.metrics.scoreboardScoreChangeRecall),
    ambiguousOcrFailClosed: avg((result) => result.metrics.ambiguousOcrFailClosed),
    noFalseGoalFromOcrOnly: avg((result) => result.metrics.noFalseGoalFromOcrOnly),
    ocrQaCalibrationSupport: avg((result) => result.metrics.ocrQaCalibrationSupport),
    matchEventTruthValidGoalRecall: avg((result) => result.metrics.matchEventTruthValidGoalRecall),
    matchEventTruthLateGoalRecall: avg((result) => result.metrics.matchEventTruthLateGoalRecall),
    matchEventTruthDisallowedClassification: avg((result) => result.metrics.matchEventTruthDisallowedClassification),
    matchEventTruthFalseGoalRate: avg((result) => result.metrics.matchEventTruthFalseGoalRate),
    matchEventTruthAnchorContract: avg((result) => result.metrics.matchEventTruthAnchorContract),
    actionWindowCoverage: avg((result) => result.metrics.actionWindowCoverage),
    shotToPayoffCoverage: avg((result) => result.metrics.shotToPayoffCoverage),
    ballPlayerVisibilityScore: avg((result) => result.metrics.ballPlayerVisibilityScore),
    cropSafetyScore: avg((result) => result.metrics.cropSafetyScore),
    actionSafeZoneCoverage: avg((result) => result.metrics.actionSafeZoneCoverage),
    textObstructionRisk: avg((result) => result.metrics.textObstructionRisk),
    wideSafeFallbackRate: avg((result) => result.metrics.wideSafeFallbackRate),
    trackingConfidenceCalibration: avg((result) => result.metrics.trackingConfidenceCalibration),
    trackingOutputValidity: avg((result) => result.metrics.trackingOutputValidity),
    ballTrackCoverage: avg((result) => result.metrics.ballTrackCoverage),
    playerClusterCoverage: avg((result) => result.metrics.playerClusterCoverage),
    softFollowPrecision: avg((result) => result.metrics.softFollowPrecision),
    wideSafeFallbackCorrectness: avg((result) => result.metrics.wideSafeFallbackCorrectness),
    falseGoalFromTrackingRate: avg((result) => result.metrics.falseGoalFromTrackingRate),
    referenceStyleSimilarity: avg((result) => result.metrics.referenceStyleSimilarity),
    renderStylePresetValidity: avg((result) => result.metrics.renderStylePresetValidity),
    unsupportedCueRate: avg((result) => result.metrics.unsupportedCueRate),
    fallbackUsageRate: avg((result) => (result.metrics.fallbackUsed ? 1 : 0)),
    visualFallbackUsageRate: avg((result) => (result.metrics.visualFallbackUsed ? 1 : 0)),
    frameExtractionFallbackUsageRate: avg((result) => (result.metrics.frameExtractionFallbackUsed ? 1 : 0)),
    sampledFrameCount: avg((result) => result.metrics.sampledFrameCount),
    candidatePlanValidity: avg((result) => result.metrics.candidatePlanValidity),
    captionTimingValidity: avg((result) => result.metrics.captionTimingValidity),
  };
}

function workspaceMetadata() {
  const metadata = {
    gitAvailable: false,
    commit: null,
    branch: null,
    dirty: null,
  };
  try {
    const gitOptions = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 };
    metadata.commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], gitOptions).trim();
    metadata.branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], gitOptions).trim();
    const status = execFileSync("git", ["status", "--porcelain"], gitOptions).trim();
    metadata.dirty = Boolean(status);
    metadata.gitAvailable = true;
  } catch {
    metadata.gitAvailable = false;
  }
  return metadata;
}

function buildReport({ fixtures, results, minAggregateScore = DEFAULT_THRESHOLDS.minAggregateScore, timestamp = new Date().toISOString() }) {
  const aggregate = aggregateResults(results);
  const failedCases = results
    .filter((result) => !result.passed)
    .map((result) => ({
      id: result.id,
      score: result.score,
      notes: result.notes,
    }));
  return {
    schemaVersion: 1,
    generatedAt: timestamp,
    metadata: {
      workspace: workspaceMetadata(),
      fixtureCount: fixtures.length,
      runner: "matchcuts-local-eval",
    },
    thresholds: {
      minAggregateScore,
    },
    aggregate,
    passed: aggregate.aggregateScore >= minAggregateScore && failedCases.length === 0,
    failedCases,
    fixtures: results,
    suggestedDebuggingNotes: failedCases.length
      ? [...new Set(failedCases.flatMap((item) => item.notes))].slice(0, 10)
      : ["Evaluation passed. Track aggregate score and reason precision over time."],
  };
}

function runEvaluation({ fixturesDir, minAggregateScore = DEFAULT_THRESHOLDS.minAggregateScore } = {}) {
  if (!fixturesDir || !existsSync(fixturesDir)) {
    throw new AppError("VALIDATION_ERROR", "Evaluation fixtures directory is missing.", 400);
  }
  const fixtures = loadFixtures(fixturesDir);
  const results = fixtures.map(scoreFixture);
  return buildReport({ fixtures, results, minAggregateScore });
}

function safeWriteReportFile(filePath, payload) {
  if (existsSync(filePath)) {
    try {
      renameSync(filePath, `${filePath}.previous-${Date.now()}`);
    } catch {
      // If rotation fails, the write attempt below will surface the filesystem problem.
    }
  }
  writeFileSync(filePath, payload, "utf8");
}

function writeReport(report, resultsDir) {
  mkdirSync(resultsDir, { recursive: true });
  const safeTimestamp = report.generatedAt.replace(/[:.]/g, "-");
  const fileName = `matchcuts-eval-${safeTimestamp}.json`;
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  const target = join(resultsDir, fileName);
  safeWriteReportFile(target, payload);
  safeWriteReportFile(join(resultsDir, "latest.json"), payload);
  return {
    fileName: basename(target),
    latest: "latest.json",
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  aggregateResults,
  animationCuesAreValid,
  animationCueRelevanceScore,
  bestOverlap,
  buildReport,
  captionsHaveValidRoles,
  captionsHaveValidTiming,
  captionProviderFallbackRate,
  captionSpecificityScore,
  reactionAsSupportScore,
  weakEvidenceNeutralityScore,
  framingIsSafe,
  cropSafetyScore,
  actionSafeZoneCoverageScore,
  textObstructionRiskValue,
  trackingConfidenceCalibrationScore,
  trackingOutputValidityScore,
  ballTrackCoverageScore,
  playerClusterCoverageScore,
  softFollowPrecisionScore,
  wideSafeFallbackCorrectnessScore,
  loadFixtures,
  overlapRatio,
  planHasGoalLanguage,
  reasonCodePrecision,
  reasonCodeRecall,
  renderStylePresetIsValid,
  runEvaluation,
  sanitizeReportText,
  scoreFixture,
  top3Recall,
  validateFixture,
  writeReport,
};
