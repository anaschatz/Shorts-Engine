const { AppError } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");
const {
  GOAL_DECISION_EVIDENCE_CODES,
  GOAL_EVENT_TYPES,
  GOAL_OUTCOMES,
  GOAL_OUTCOME_BADGES,
  OFFSIDE_STATUSES,
  hasGoalLanguage,
  normalizeGoalOutcome,
} = require("./edit-plan.cjs");

const OFFSIDE_TERMS = Object.freeze([
  "offside",
  "flag is up",
  "flag goes up",
  "assistant referee",
  "οφσαιντ",
  "οφσάιντ",
  "σημαια",
  "σημαία",
  "εποπτης",
  "επόπτης",
]);

const DISALLOWED_TERMS = Object.freeze([
  "disallowed",
  "ruled out",
  "chalked off",
  "no goal",
  "does not count",
  "won't count",
  "will not count",
  "ακυρωνεται",
  "ακυρώνεται",
  "ακυρωθηκε",
  "ακυρώθηκε",
  "δεν μετρα",
  "δεν μέτρα",
  "δεν μετρά",
]);

const VAR_TERMS = Object.freeze(["var", "check", "review", "checking", "video assistant", "ελεγχος", "έλεγχος"]);
const CONFIRMED_GOAL_TERMS = Object.freeze([
  "goal confirmed",
  "confirmed goal",
  "it counts",
  "the goal stands",
  "finish counts",
  "given as a goal",
  "μετραει",
  "μετράει",
  "το γκολ μετρα",
  "το γκολ μετρά",
]);

const VISUAL_DECISION_REASON_BY_TYPE = Object.freeze({
  assistant_referee_flag: "visual_offside_flag",
  referee_no_goal_signal: "visual_referee_no_goal_signal",
  referee_goal_signal: "visual_referee_goal_signal",
  referee_signal: "visual_referee_decision",
  var_screen: "visual_var_check",
  var_check_graphic: "visual_var_check",
  var_decision_graphic: "visual_var_decision",
  replay_line: "visual_offside_line",
  offside_line_replay: "visual_offside_line",
  scoreboard_no_goal: "visual_no_goal_decision",
  scoreboard_goal_removed: "visual_scoreboard_goal_removed",
  scoreboard_goal_confirmed: "visual_scoreboard_goal_confirmed",
  replay_angle: "visual_replay_angle",
  crowd_confusion: "visual_crowd_confusion",
  celebration_after_whistle: "visual_celebration_after_whistle",
});

const DISALLOWED_DECISION_CODES = Object.freeze([
  "flag_commentary",
  "disallowed_commentary",
  "no_goal_commentary",
  "visual_offside_flag",
  "visual_no_goal_decision",
  "visual_offside_line",
  "visual_referee_no_goal_signal",
  "visual_scoreboard_goal_removed",
  "scoreboard_ocr_goal_removed",
  "scoreboard_ocr_score_unchanged",
]);

const POSSIBLE_DECISION_CODES = Object.freeze([
  "offside_commentary",
  "var_check",
  "var_decision",
  "visual_var_check",
  "visual_var_decision",
  "visual_referee_decision",
  "visual_replay_angle",
  "visual_crowd_confusion",
  "visual_celebration_after_whistle",
]);

const CONFIRMED_DECISION_CODES = Object.freeze([
  "confirmed_by_commentary",
  "visual_referee_goal_signal",
  "visual_scoreboard_goal_confirmed",
  "scoreboard_goal_confirmed",
  "combined_goal_confirmation",
  "kickoff_after_goal",
]);

function seconds(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function hasTerm(text, terms) {
  const lower = sanitizeText(text, 240).toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
}

function safeTextEvidence(text) {
  const safe = sanitizeText(text, 180);
  const evidence = [];
  if (hasTerm(safe, OFFSIDE_TERMS)) evidence.push("offside_commentary");
  if (/\bflag\b/i.test(safe) || hasTerm(safe, ["σημαια", "σημαία"])) evidence.push("flag_commentary");
  if (hasTerm(safe, DISALLOWED_TERMS)) evidence.push("disallowed_commentary");
  if (hasTerm(safe, VAR_TERMS)) evidence.push("var_check");
  if (/no\s+goal/i.test(safe) || /δεν\s+μετρ/i.test(safe)) evidence.push("no_goal_commentary");
  if (hasTerm(safe, CONFIRMED_GOAL_TERMS)) evidence.push("confirmed_by_commentary");
  if (hasGoalLanguage(safe)) evidence.push("explicit_goal_language");
  return [...new Set(evidence)];
}

function captionEvidenceInRange(captions = [], start = 0, end = 0) {
  return (Array.isArray(captions) ? captions : [])
    .filter((caption) => seconds(caption.start) <= end && seconds(caption.end) >= start)
    .map((caption) => {
      const text = sanitizeText(caption.text, 180);
      return {
        start: seconds(caption.start),
        end: seconds(caption.end),
        text,
        evidence: safeTextEvidence(text),
      };
    })
    .filter((item) => item.evidence.length);
}

function reasonCodesForVisualWindow(window = {}) {
  if (Array.isArray(window.reasonCodes)) return window.reasonCodes.map((item) => sanitizeText(item, 64)).filter(Boolean);
  const rawTypes = Array.isArray(window.types) && window.types.length
    ? window.types
    : Array.isArray(window.labels) && window.labels.length
      ? window.labels
      : [window.type || window.label].filter(Boolean);
  return rawTypes
    .map((type) => VISUAL_DECISION_REASON_BY_TYPE[sanitizeText(type, 64).toLowerCase()])
    .filter(Boolean);
}

function decisionVisualEvidence(windows = []) {
  return [...new Set((Array.isArray(windows) ? windows : []).flatMap(reasonCodesForVisualWindow))]
    .filter((reason) => [
      ...DISALLOWED_DECISION_CODES,
      ...POSSIBLE_DECISION_CODES,
      ...CONFIRMED_DECISION_CODES,
      "visual_replay_indicator",
    ].includes(reason));
}

function firstDecisionTimestamp({ textEvidenceItems = [], visualWindows = [], fallback = null } = {}) {
  if (textEvidenceItems.length) return textEvidenceItems[0].start;
  const visual = (Array.isArray(visualWindows) ? visualWindows : []).find((window) => decisionVisualEvidence([window]).length);
  if (visual) return seconds(visual.start);
  return fallback;
}

function goalOutcomeBadgeFor({ outcome, decisionEvidence = [] }) {
  if (outcome === "confirmed_goal") return "CONFIRMED GOAL";
  if (outcome === "disallowed_offside") return "OFFSIDE - NO GOAL";
  if (outcome === "possible_offside") {
    return decisionEvidence.some((code) => code === "var_check" || code === "var_decision" || code === "visual_var_check" || code === "visual_var_decision")
      ? "VAR CHECK"
      : "POSSIBLE OFFSIDE";
  }
  if (outcome === "unknown_decision") return "DECISION UNCLEAR";
  return null;
}

function explanationForOutcome(outcome, decisionEvidence = []) {
  if (outcome === "confirmed_goal") return "Goal confirmed by explicit decision evidence.";
  if (outcome === "disallowed_offside") return "Ball-in-net moment is kept, but decision evidence marks it as offside/no goal.";
  if (outcome === "possible_offside") return "Ball-in-net moment has VAR/offside decision cues without a final confirmed outcome.";
  if (decisionEvidence.includes("ball_in_net")) return "Ball-in-net evidence exists, but final decision evidence is unclear.";
  return "No ball-in-net goal outcome detected.";
}

function resolveGoalOutcome({
  reasons = [],
  goalEvidence = {},
  visualWindows = [],
  captions = [],
  start = 0,
  end = 0,
  payoffEnd = null,
} = {}) {
  const reasonSet = new Set(Array.isArray(reasons) ? reasons : []);
  const decisionReasonCodes = [...reasonSet].filter((reason) => [
    ...DISALLOWED_DECISION_CODES,
    ...POSSIBLE_DECISION_CODES,
    ...CONFIRMED_DECISION_CODES,
    "visual_replay_indicator",
  ].includes(reason));
  const visualReasonCodes = [...new Set([...decisionVisualEvidence(visualWindows), ...decisionReasonCodes])];
  const ballInNet = Boolean(
    goalEvidence.hasBallInNetOrLineCross ||
    reasonSet.has("visual_ball_in_net") ||
    reasonSet.has("goal") ||
    goalEvidence.explicitTextGoal,
  );
  if (!ballInNet) {
    return normalizeGoalOutcome(null, { highlightType: "generic_highlight", reasonCodes: reasons });
  }

  const safeStart = seconds(start);
  const safeEnd = Math.max(safeStart, seconds(end, safeStart));
  const payoff = Number.isFinite(Number(payoffEnd)) ? seconds(payoffEnd) : seconds(goalEvidence.payoffEnd, safeStart);
  const decisionStart = Math.max(safeStart, payoff - 0.25);
  const decisionEnd = Math.max(safeEnd, decisionStart + 0.75);
  const textEvidenceItems = captionEvidenceInRange(captions, decisionStart, decisionEnd);
  const fullWindowTextEvidenceItems = captionEvidenceInRange(captions, safeStart, safeEnd);
  const textEvidence = [...new Set(textEvidenceItems.flatMap((item) => item.evidence))];
  const fullTextEvidence = [...new Set(fullWindowTextEvidenceItems.flatMap((item) => item.evidence))];
  const decisionEvidence = [...new Set([
    "ball_in_net",
    ...textEvidence,
    ...visualReasonCodes,
  ].filter(Boolean))];
  const allEvidence = [...new Set([...decisionEvidence, ...fullTextEvidence])];
  const hasDisallowed = allEvidence.some((code) => DISALLOWED_DECISION_CODES.includes(code));
  const hasPossible = allEvidence.some((code) => POSSIBLE_DECISION_CODES.includes(code));
  const hasConfirmed = allEvidence.some((code) => CONFIRMED_DECISION_CODES.includes(code));
  const outcome = hasDisallowed
    ? "disallowed_offside"
    : hasConfirmed
      ? "confirmed_goal"
      : hasPossible
        ? "possible_offside"
        : "unknown_decision";
  const confidence = outcome === "disallowed_offside"
    ? 0.94
    : outcome === "confirmed_goal"
      ? Math.max(0.82, Number(goalEvidence.confidence || 0))
      : outcome === "possible_offside"
        ? 0.74
        : Math.max(0.45, Math.min(0.68, Number(goalEvidence.confidence || 0.48)));
  const decisionTimestamp = firstDecisionTimestamp({
    textEvidenceItems,
    visualWindows,
    fallback: outcome === "unknown_decision" ? null : decisionStart,
  });
  const postContextSeconds = Math.max(0, Number((decisionEnd - Math.max(safeStart, payoff)).toFixed(2)));
  return normalizeGoalOutcome({
    eventType: "ball_in_net",
    outcome,
    offsideStatus: outcome === "disallowed_offside" ? "offside" : outcome === "possible_offside" ? "possible" : outcome === "confirmed_goal" ? "onside" : "unknown",
    decisionEvidence,
    decisionTimestamp: Number.isFinite(Number(decisionTimestamp)) ? Number(decisionTimestamp) : null,
    decisionWindow: { start: decisionStart, end: decisionEnd },
    confidence,
    requiresPostContext: outcome !== "confirmed_goal",
    postContextSeconds: Math.min(15, clamp(postContextSeconds, 0, 15)),
    safeCaptionBadge: goalOutcomeBadgeFor({ outcome, decisionEvidence }),
    explanation: explanationForOutcome(outcome, decisionEvidence),
    captionSafetyFlags: outcome === "disallowed_offside"
      ? ["offside_decision_context"]
      : ["possible_offside", "unknown_decision"].includes(outcome)
        ? ["goal_outcome_uncertain"]
        : [],
  }, { highlightType: "goal", reasonCodes: reasons });
}

function assertKnownGoalOutcomeShape(goalOutcome) {
  try {
    return normalizeGoalOutcome(goalOutcome, { highlightType: "goal", reasonCodes: ["goal"] });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("VALIDATION_ERROR", "Goal outcome shape is invalid.", 400);
  }
}

module.exports = {
  CONFIRMED_DECISION_CODES,
  DISALLOWED_DECISION_CODES,
  GOAL_DECISION_EVIDENCE_CODES,
  GOAL_EVENT_TYPES,
  GOAL_OUTCOMES,
  GOAL_OUTCOME_BADGES,
  OFFSIDE_STATUSES,
  POSSIBLE_DECISION_CODES,
  captionEvidenceInRange,
  decisionVisualEvidence,
  goalOutcomeBadgeFor,
  resolveGoalOutcome,
  assertKnownGoalOutcomeShape,
};
