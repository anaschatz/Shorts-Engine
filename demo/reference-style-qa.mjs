import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSensitiveLeak } from "./report-safety.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_DIR = resolve(ROOT_DIR, "demo", "results");
const DEFAULT_PROOF_REPORT = "demo/results/youtube-live-e2e-latest.json";
const DEFAULT_VISUAL_QA_REPORT = "demo/results/visual-goal-qa-latest.json";
const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const REFERENCE_STYLE_QA_SCHEMA_VERSION = 1;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SCORE_RE = /^(\d{1,2})-(\d{1,2})$/;

class ReferenceStyleQAError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ReferenceStyleQAError";
    this.code = code;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function stampFromIso(value) {
  return String(value || nowIso()).replace(/[:.]/g, "-").replace(/[^A-Za-z0-9TZ_-]/g, "-");
}

function round(value, digits = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

function clampScore(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function safeString(value, maxLength = 140) {
  return String(value || "")
    .replace(/\/Users\/[^\s"']+/g, "[redacted-path]")
    .replace(/\/private\/[^\s"']+/g, "[redacted-path]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/token|secret|api[_-]?key|cookie/gi, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeReasons(values = [], max = 18) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => safeString(value, 120))
    .filter(Boolean))]
    .slice(0, max);
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !resolve(rel).startsWith(".."));
}

function safeRelativeRef(rootDir, candidate, { requiredPrefix = null, extension = null } = {}) {
  const text = String(candidate || "").trim().replace(/\\/g, "/");
  if (
    !text ||
    text.startsWith("/") ||
    /^[A-Za-z]:\//.test(text) ||
    text.includes("\0") ||
    text.split("/").some((part) => part === "..") ||
    (requiredPrefix && !text.startsWith(requiredPrefix)) ||
    (extension && extname(text).toLowerCase() !== extension)
  ) {
    return { ok: false, code: "REFERENCE_STYLE_QA_REF_UNSAFE", relativePath: null, resolvedFile: null };
  }
  const root = resolve(rootDir || ROOT_DIR);
  const resolvedFile = resolve(root, text);
  if (!isInside(root, resolvedFile)) {
    return { ok: false, code: "REFERENCE_STYLE_QA_REF_UNSAFE", relativePath: null, resolvedFile: null };
  }
  return { ok: true, code: null, relativePath: text, resolvedFile };
}

function atomicWriteJson(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function parseMaxAgeMs(value = process.env.SHORTSENGINE_REFERENCE_STYLE_QA_MAX_AGE_MS) {
  if (value === undefined || value === null || value === "") return DEFAULT_MAX_AGE_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 60_000 || parsed > 24 * 60 * 60 * 1000) {
    throw new ReferenceStyleQAError("REFERENCE_STYLE_QA_MAX_AGE_INVALID", "Reference style QA max age is invalid.");
  }
  return Math.floor(parsed);
}

function reportFresh(report, now, maxAgeMs) {
  const reportMs = Date.parse(report?.timestamp || report?.generatedAt || "");
  const nowMs = Date.parse(now || nowIso());
  return Number.isFinite(reportMs) &&
    Number.isFinite(nowMs) &&
    reportMs <= nowMs + MAX_CLOCK_SKEW_MS &&
    nowMs - reportMs <= maxAgeMs;
}

function assertSafeReport(value) {
  const leak = findSensitiveLeak(value);
  if (leak) {
    throw new ReferenceStyleQAError("REFERENCE_STYLE_QA_REPORT_LEAK", "Reference style QA report contains unsafe data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
}

function parseScore(value) {
  const match = String(value || "").trim().match(SCORE_RE);
  if (!match) return null;
  return { home: Number(match[1]), away: Number(match[2]) };
}

function isUnitIncrease(before, after) {
  const from = parseScore(before);
  const to = parseScore(after);
  if (!from || !to) return false;
  const homeDelta = to.home - from.home;
  const awayDelta = to.away - from.away;
  return (homeDelta === 1 && awayDelta === 0) || (homeDelta === 0 && awayDelta === 1);
}

function roleClear(goal = {}, role) {
  return Array.isArray(goal.frames) && goal.frames.some((frame) => frame && frame.role === role && frame.clear === true);
}

function phaseScoreForGoal(goal = {}) {
  const roles = ["buildup", "pre_shot", "finish", "payoff", "confirmation"];
  return clampScore((roles.filter((role) => roleClear(goal, role)).length / roles.length) * 100);
}

function analyzeGoalPacing(goal = {}) {
  const segment = goal.segment || {};
  const duration = Number(segment.durationSeconds);
  const sourceStart = Number(segment.sourceStart);
  const shotStart = Number(segment.shotStart);
  const finishTime = Number(segment.finishTime);
  const confirmationTime = Number(segment.confirmationTime);
  const sourceEnd = Number(segment.sourceEnd);
  const preShotContext = Number.isFinite(sourceStart) && Number.isFinite(shotStart) ? shotStart - sourceStart : null;
  const shotToFinish = Number.isFinite(shotStart) && Number.isFinite(finishTime) ? finishTime - shotStart : null;
  const finishToConfirmation = Number.isFinite(finishTime) && Number.isFinite(confirmationTime) ? confirmationTime - finishTime : null;
  const postConfirmationTail = Number.isFinite(sourceEnd) && Number.isFinite(confirmationTime) ? sourceEnd - confirmationTime : null;
  const deadAirSeconds = Math.max(0, (preShotContext ?? 0) - 24) + Math.max(0, (postConfirmationTail ?? 0) - 4);
  const reasons = safeReasons([
    ...(!Number.isFinite(duration) ? ["segment_duration_missing"] : []),
    ...(Number.isFinite(duration) && duration < 10 ? ["segment_too_short_for_goal_phase"] : []),
    ...(Number.isFinite(duration) && duration > 36 ? ["segment_too_long_dead_air_risk"] : []),
    ...(preShotContext != null && preShotContext < 3 ? ["not_enough_buildup_before_shot"] : []),
    ...(preShotContext != null && preShotContext > 24 ? ["pre_shot_context_too_long"] : []),
    ...(shotToFinish != null && (shotToFinish < 0.25 || shotToFinish > 8) ? ["shot_to_finish_timing_suspicious"] : []),
    ...(finishToConfirmation != null && finishToConfirmation > 10 ? ["confirmation_tail_too_late"] : []),
    ...(postConfirmationTail != null && postConfirmationTail > 4 ? ["post_confirmation_tail_too_long"] : []),
  ]);
  const score = clampScore(100 - deadAirSeconds * 7 - reasons.length * 6);
  return {
    goalNumber: Number(goal.goalNumber) || null,
    durationSeconds: round(duration),
    preShotContextSeconds: round(preShotContext),
    shotToFinishSeconds: round(shotToFinish),
    finishToConfirmationSeconds: round(finishToConfirmation),
    postConfirmationTailSeconds: round(postConfirmationTail),
    deadAirSeconds: round(deadAirSeconds),
    score,
    reasons,
    suggestedEditPlanChanges: suggestedGoalPacingChanges(goal, reasons),
  };
}

function suggestedGoalPacingChanges(goal = {}, reasons = []) {
  const goalNumber = Number(goal.goalNumber) || null;
  return safeReasons([
    ...(reasons.includes("pre_shot_context_too_long") ? [`goal_${goalNumber}_trim_or_anchor_buildup_closer_to_attack_start`] : []),
    ...(reasons.includes("not_enough_buildup_before_shot") ? [`goal_${goalNumber}_move_source_start_earlier_for_buildup`] : []),
    ...(reasons.includes("post_confirmation_tail_too_long") ? [`goal_${goalNumber}_trim_after_confirmation`] : []),
    ...(reasons.includes("segment_too_short_for_goal_phase") ? [`goal_${goalNumber}_extend_goal_phase_window`] : []),
    ...(reasons.includes("segment_too_long_dead_air_risk") ? [`goal_${goalNumber}_tighten_goal_phase_window`] : []),
  ], 6);
}

function scoreProgressionFromContactSheet(goals = []) {
  const transitions = goals.map((goal, index) => {
    const before = goal.scoreTransition?.before || null;
    const after = goal.scoreTransition?.after || null;
    const previous = index > 0 ? goals[index - 1]?.scoreTransition?.after : null;
    const unitIncrease = isUnitIncrease(before, after);
    const chainMatches = index === 0 || previous === before;
    return {
      goalNumber: Number(goal.goalNumber) || index + 1,
      transition: before && after ? `${before} -> ${after}` : null,
      unitIncrease,
      chainMatches,
      passed: Boolean(before && after && unitIncrease && chainMatches),
    };
  });
  return {
    passed: transitions.length > 0 && transitions.every((transition) => transition.passed),
    transitions,
    reasons: safeReasons([
      ...transitions.filter((transition) => !transition.unitIncrease).map(() => "score_transition_not_unit_increase"),
      ...transitions.filter((transition) => !transition.chainMatches).map(() => "score_transition_chain_mismatch"),
    ]),
  };
}

function duplicateRisk(goals = []) {
  const seenTransitions = new Set();
  const repeated = [];
  const overlapping = [];
  goals.forEach((goal, index) => {
    const key = `${goal.scoreTransition?.before || "?"}->${goal.scoreTransition?.after || "?"}`;
    if (seenTransitions.has(key)) repeated.push({ goalNumber: Number(goal.goalNumber) || index + 1, reason: "duplicate_score_transition" });
    seenTransitions.add(key);
    if (index > 0) {
      const previous = goals[index - 1]?.segment || {};
      const current = goal.segment || {};
      const previousEnd = Number(previous.sourceEnd);
      const currentStart = Number(current.sourceStart);
      if (Number.isFinite(previousEnd) && Number.isFinite(currentStart) && currentStart < previousEnd - 2) {
        overlapping.push({
          leftGoalNumber: Number(goals[index - 1].goalNumber) || index,
          rightGoalNumber: Number(goal.goalNumber) || index + 1,
          reason: "overlapping_rendered_goal_windows",
        });
      }
    }
  });
  return {
    passed: repeated.length === 0 && overlapping.length === 0,
    repeated,
    overlapping,
    reasons: safeReasons([
      ...(repeated.length ? ["duplicate_score_transition"] : []),
      ...(overlapping.length ? ["overlapping_goal_windows"] : []),
    ]),
  };
}

function hookReview(proof = {}) {
  const social = proof.outputProof?.renderedSocialPolishQA || {};
  const hook = social.renderedHook || {};
  const captions = social.dynamicCaptions || {};
  const hookStart = Number(hook.hookStart);
  const hookEnd = Number(hook.hookEnd);
  const reasons = safeReasons([
    ...(hook.passed !== true ? ["rendered_hook_gate_failed"] : []),
    ...(!Number.isFinite(hookStart) || hookStart > 0.25 ? ["hook_not_immediate"] : []),
    ...(!Number.isFinite(hookEnd) || hookEnd > 2.05 ? ["hook_not_inside_first_two_seconds"] : []),
    ...(captions.openingHookCaptionRendered !== true ? ["opening_hook_caption_missing"] : []),
    ...(hook.noFalseGoalClaim === false ? ["hook_false_goal_claim_risk"] : []),
  ]);
  const softNotes = safeReasons([
    ...(!hook.hookText ? ["hook_text_missing_from_rendered_social_summary"] : []),
    ...(Number(hook.relatedGoalNumber) === 0 ? ["hook_related_goal_number_not_mapped"] : []),
  ], 6);
  return {
    passed: reasons.length === 0,
    score: clampScore(100 - reasons.length * 25 - softNotes.length * 5),
    hookStart: round(hookStart),
    hookEnd: round(hookEnd),
    hookType: safeString(hook.hookType, 50),
    hookText: safeString(hook.hookText, 120) || null,
    openingHookCaptionRendered: captions.openingHookCaptionRendered === true,
    noFalseGoalClaim: hook.noFalseGoalClaim !== false,
    reasons,
    notes: softNotes,
  };
}

function captionReview(proof = {}) {
  const social = proof.outputProof?.renderedSocialPolishQA || {};
  const captions = social.dynamicCaptions || {};
  const reasons = safeReasons([
    ...(captions.passed !== true ? ["dynamic_caption_gate_failed"] : []),
    ...((Number(captions.dynamicWordCaptionCount) || 0) <= 0 ? ["dynamic_word_captions_missing"] : []),
    ...(captions.openingHookCaptionRendered !== true ? ["opening_hook_caption_not_rendered"] : []),
    ...(captions.textObstructionRisk === true ? ["caption_text_obstruction_risk"] : []),
  ]);
  return {
    passed: reasons.length === 0,
    score: clampScore(100 - reasons.length * 28),
    dynamicWordCaptionCount: Number(captions.dynamicWordCaptionCount) || 0,
    captionCount: Number(captions.captionCount) || null,
    readableCaptionCount: Number(captions.readableCaptionCount) || null,
    activeWordHighlightRendered: captions.activeWordHighlightRendered === true,
    textObstructionRisk: captions.textObstructionRisk === true,
    reasons,
  };
}

function transitionReview(proof = {}) {
  const social = proof.outputProof?.renderedSocialPolishQA || {};
  const smooth = social.smoothEditing || {};
  const segmentCount = Number(smooth.segmentCount) || 0;
  const transitionCount = Number(smooth.transitionRenderedCount) || 0;
  const hardCutFallbackCount = Number(smooth.hardCutFallbackCount) || 0;
  const abruptCutRiskCount = Number(smooth.abruptCutRiskCount) || 0;
  const reasons = safeReasons([
    ...(smooth.passed !== true ? ["smooth_editing_gate_failed"] : []),
    ...(segmentCount > 1 && transitionCount < segmentCount - 1 ? ["transition_coverage_missing"] : []),
    ...(hardCutFallbackCount > 0 ? ["hard_cut_fallback_present"] : []),
    ...(abruptCutRiskCount > 0 ? ["abrupt_cut_risk_present"] : []),
  ]);
  return {
    passed: reasons.length === 0,
    score: clampScore(100 - reasons.length * 24),
    segmentCount,
    transitionRenderedCount: transitionCount,
    hardCutFallbackCount,
    abruptCutRiskCount,
    transitions: Array.isArray(smooth.transitions) ? smooth.transitions.slice(0, 8).map((transition, index) => ({
      index: index + 1,
      type: safeString(transition.type, 60),
      timelineStart: round(transition.timelineStart),
      durationSeconds: round(transition.durationSeconds),
    })) : [],
    reasons,
  };
}

function cropReview(proof = {}) {
  const social = proof.outputProof?.renderedSocialPolishQA || {};
  const framing = social.renderedActionFraming || {};
  const reasons = safeReasons([
    ...(framing.passed !== true ? ["action_framing_gate_failed"] : []),
    ...(framing.textObstructionRisk === true ? ["caption_text_obstruction_risk"] : []),
    ...(framing.abruptCropPanRisk === true ? ["abrupt_crop_pan_risk"] : []),
  ]);
  const notes = safeReasons([
    ...(framing.cropMode === "wide_safe" ? ["wide_safe_framing_used_tracking_not_yet_reference_closeup"] : []),
    ...(framing.fallbackUsed === true ? ["tracking_fallback_used"] : []),
  ], 6);
  return {
    passed: reasons.length === 0,
    score: clampScore(100 - reasons.length * 28 - notes.length * 4),
    cropMode: safeString(framing.cropMode, 60),
    trackingProviderMode: safeString(framing.trackingProviderMode, 80),
    fallbackUsed: framing.fallbackUsed === true,
    textObstructionRisk: framing.textObstructionRisk === true,
    abruptCropPanRisk: framing.abruptCropPanRisk === true,
    reasons,
    notes,
  };
}

function buildReferenceStyleQAReport({
  proof = {},
  visual = {},
  contactSheet = {},
  proofReportPath = DEFAULT_PROOF_REPORT,
  visualReportPath = DEFAULT_VISUAL_QA_REPORT,
  contactSheetPath = null,
  outputRef = null,
  mp4Stats = null,
  proofFresh = true,
  visualFresh = true,
  generatedAt = nowIso(),
} = {}) {
  const goals = Array.isArray(contactSheet.goals) ? contactSheet.goals : [];
  const expectedGoalCount = Number(visual.expectedGoalCount || proof.outputProof?.expectedCountedGoals || goals.length) || null;
  const goalPacing = goals.map(analyzeGoalPacing);
  const totalDeadAirSeconds = round(goalPacing.reduce((sum, goal) => sum + (Number(goal.deadAirSeconds) || 0), 0));
  const goalPhaseScores = goals.map(phaseScoreForGoal);
  const progression = scoreProgressionFromContactSheet(goals);
  const duplicates = duplicateRisk(goals);
  const hook = hookReview(proof);
  const captions = captionReview(proof);
  const transitions = transitionReview(proof);
  const crop = cropReview(proof);
  const replayOnlyGoals = goals.filter((goal) => goal.segment?.replayOnly === true).map((goal) => Number(goal.goalNumber)).filter(Number.isFinite);
  const categoryScores = {
    hookStrength: hook.score,
    firstTwoSecondsImpact: hook.openingHookCaptionRendered ? hook.score : Math.min(hook.score, 60),
    deadAirControl: clampScore(100 - (Number(totalDeadAirSeconds) || 0) * 8),
    goalPhaseCompleteness: clampScore(goalPhaseScores.reduce((sum, score) => sum + score, 0) / Math.max(1, goalPhaseScores.length)),
    cutSmoothness: transitions.score,
    transitionQuality: transitions.score,
    captionReadability: captions.score,
    captionActionAlignment: visual.rubric?.captionReadabilityScore === 100 ? captions.score : Math.min(captions.score, 78),
    cropActionVisibility: crop.score,
    replayUsage: replayOnlyGoals.length ? 0 : 100,
  };
  const overallWatchabilityScore = clampScore(
    categoryScores.hookStrength * 0.12 +
    categoryScores.firstTwoSecondsImpact * 0.08 +
    categoryScores.deadAirControl * 0.12 +
    categoryScores.goalPhaseCompleteness * 0.18 +
    categoryScores.cutSmoothness * 0.1 +
    categoryScores.transitionQuality * 0.08 +
    categoryScores.captionReadability * 0.1 +
    categoryScores.captionActionAlignment * 0.08 +
    categoryScores.cropActionVisibility * 0.08 +
    categoryScores.replayUsage * 0.06
  );
  const hardFailures = safeReasons([
    ...(proof.status !== "passed" || proof.passed !== true ? ["live_youtube_proof_not_passed"] : []),
    ...(visual.status !== "passed" || visual.passed !== true ? ["visual_goal_qa_not_passed"] : []),
    ...(!proofFresh ? ["live_youtube_proof_stale"] : []),
    ...(!visualFresh ? ["visual_goal_qa_stale"] : []),
    ...(!outputRef?.ok || !mp4Stats ? ["output_mp4_missing"] : []),
    ...(/latest|cached|previous/i.test(String(outputRef?.relativePath || "")) ? ["output_mp4_reference_not_unique"] : []),
    ...(expectedGoalCount != null && goals.length !== expectedGoalCount ? ["expected_goal_count_mismatch"] : []),
    ...goals.filter((goal) => goal.clear !== true).map((goal) => `goal_${goal.goalNumber}_not_human_visible`),
    ...(!progression.passed ? progression.reasons : []),
    ...(!duplicates.passed ? duplicates.reasons : []),
    ...(!hook.passed ? hook.reasons : []),
    ...(!captions.passed ? captions.reasons : []),
    ...(!transitions.passed ? transitions.reasons : []),
    ...(!crop.passed ? crop.reasons : []),
    ...(replayOnlyGoals.length ? ["replay_only_goal_segment_present"] : []),
    ...(overallWatchabilityScore < 82 ? ["overall_reference_style_score_below_threshold"] : []),
  ], 24);
  const tuningNotes = safeReasons([
    ...goalPacing.flatMap((goal) => goal.reasons.map((reason) => `goal_${goal.goalNumber}_${reason}`)),
    ...hook.notes,
    ...crop.notes,
    ...(overallWatchabilityScore < 92 ? ["manual_side_by_side_review_recommended_before_product_sample"] : []),
  ], 24);
  const passed = hardFailures.length === 0;
  const report = {
    schemaVersion: REFERENCE_STYLE_QA_SCHEMA_VERSION,
    timestamp: generatedAt,
    generatedAt,
    phase: "reference_style_side_by_side_qa",
    status: passed ? "passed" : "failed",
    passed,
    sourceProofReport: proofReportPath,
    visualGoalQAReport: visualReportPath,
    contactSheetPath,
    outputMp4: {
      relativePath: outputRef?.relativePath || null,
      sizeBytes: mp4Stats ? mp4Stats.size : null,
      durationSeconds: round(visual.outputMp4?.durationSeconds || proof.outputProof?.ffprobe?.durationSeconds),
      width: Number(visual.outputMp4?.width || proof.outputProof?.ffprobe?.width) || null,
      height: Number(visual.outputMp4?.height || proof.outputProof?.ffprobe?.height) || null,
    },
    expectedGoalCount,
    goalCount: goals.length,
    categoryScores,
    overallWatchabilityScore,
    hook,
    captions,
    pacing: {
      passed: goalPacing.every((goal) => !goal.reasons.includes("segment_too_short_for_goal_phase") && !goal.reasons.includes("segment_too_long_dead_air_risk")),
      totalDeadAirSeconds,
      goalPacing,
    },
    transitions,
    crop,
    replayUsage: {
      passed: replayOnlyGoals.length === 0,
      replayOnlyGoalNumbers: replayOnlyGoals,
    },
    scoreProgression: progression,
    duplicateRisk: duplicates,
    perGoalPacingNotes: goalPacing.map((goal) => ({
      goalNumber: goal.goalNumber,
      score: goal.score,
      reasons: goal.reasons,
      suggestedEditPlanChanges: goal.suggestedEditPlanChanges,
    })),
    suggestedEditPlanChanges: safeReasons([
      ...goalPacing.flatMap((goal) => goal.suggestedEditPlanChanges),
      ...(!hook.passed ? ["strengthen_opening_hook_inside_first_two_seconds"] : []),
      ...(!captions.passed ? ["improve_dynamic_caption_readability_and_safe_area"] : []),
      ...(!transitions.passed ? ["add_or_fix_goal_to_goal_transition_cues"] : []),
      ...(!crop.passed ? ["fix_crop_action_visibility_or_use_wide_safe_fallback"] : []),
    ], 24),
    referenceStyleChecklist: [
      { id: "fresh_mp4", passed: Boolean(outputRef?.ok && mp4Stats) && proofFresh && visualFresh },
      { id: "five_confirmed_goals_visible", passed: expectedGoalCount != null && goals.length === expectedGoalCount && goals.every((goal) => goal.clear === true) },
      { id: "hook_first_two_seconds", passed: hook.passed },
      { id: "dynamic_captions_readable", passed: captions.passed },
      { id: "smooth_cuts", passed: transitions.passed },
      { id: "chronological_score_progression", passed: progression.passed },
      { id: "no_duplicate_goal_segments", passed: duplicates.passed },
      { id: "no_replay_only_main_segments", passed: replayOnlyGoals.length === 0 },
      { id: "safe_action_framing", passed: crop.passed },
    ],
    failedReasons: hardFailures,
    failedCases: passed ? [] : hardFailures.map((code) => ({ code })),
    tuningNotes,
    remainingDifferencesFromReference: tuningNotes.length ? tuningNotes : [
      "manual_side_by_side_review_against_reference_short",
      "collect_operator_scores_for_style_taste",
    ],
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
  assertSafeReport(report);
  return report;
}

function loadReferenceStyleInputs({
  rootDir = ROOT_DIR,
  proofReport = DEFAULT_PROOF_REPORT,
  visualReport = DEFAULT_VISUAL_QA_REPORT,
  now = nowIso(),
  maxAgeMs = parseMaxAgeMs(),
} = {}) {
  const proofRef = safeRelativeRef(rootDir, proofReport, { requiredPrefix: "demo/results/", extension: ".json" });
  const visualRef = safeRelativeRef(rootDir, visualReport, { requiredPrefix: "demo/results/", extension: ".json" });
  if (!proofRef.ok || !existsSync(proofRef.resolvedFile)) {
    throw new ReferenceStyleQAError("REFERENCE_STYLE_QA_PROOF_MISSING", "Reference style QA needs a safe live proof report.", {
      report: proofRef.relativePath || proofReport,
    });
  }
  if (!visualRef.ok || !existsSync(visualRef.resolvedFile)) {
    throw new ReferenceStyleQAError("REFERENCE_STYLE_QA_VISUAL_REPORT_MISSING", "Reference style QA needs a safe visual goal QA report.", {
      report: visualRef.relativePath || visualReport,
    });
  }
  const proof = readJson(proofRef.resolvedFile);
  const visual = readJson(visualRef.resolvedFile);
  assertSafeReport(proof);
  assertSafeReport(visual);
  const contactRef = safeRelativeRef(rootDir, visual.contactSheetPath, { requiredPrefix: "demo/results/", extension: ".json" });
  if (!contactRef.ok || !existsSync(contactRef.resolvedFile)) {
    throw new ReferenceStyleQAError("REFERENCE_STYLE_QA_CONTACT_SHEET_MISSING", "Reference style QA needs a safe visual contact sheet.", {
      report: contactRef.relativePath || visual.contactSheetPath || null,
    });
  }
  const contactSheet = readJson(contactRef.resolvedFile);
  assertSafeReport(contactSheet);
  const outputRef = safeRelativeRef(rootDir, visual.outputMp4?.relativePath || proof.outputProof?.outputMp4?.relativePath, {
    requiredPrefix: "manual-downloads/",
    extension: ".mp4",
  });
  const mp4Stats = outputRef.ok && existsSync(outputRef.resolvedFile) ? statSync(outputRef.resolvedFile) : null;
  return {
    proof,
    visual,
    contactSheet,
    proofReportPath: proofRef.relativePath,
    visualReportPath: visualRef.relativePath,
    contactSheetPath: contactRef.relativePath,
    outputRef,
    mp4Stats,
    proofFresh: reportFresh(proof, now, maxAgeMs),
    visualFresh: reportFresh(visual, now, maxAgeMs),
  };
}

function analyzeReferenceStyleQA(options = {}) {
  const now = options.now || nowIso();
  return buildReferenceStyleQAReport({
    ...loadReferenceStyleInputs({ ...options, now }),
    generatedAt: now,
  });
}

function writeReferenceStyleQA({
  rootDir = ROOT_DIR,
  resultsDir = RESULTS_DIR,
  now = nowIso(),
  ...options
} = {}) {
  const report = analyzeReferenceStyleQA({ ...options, rootDir, now });
  const stamp = stampFromIso(now);
  const safeResultsDir = resolve(resultsDir);
  const reportFile = resolve(safeResultsDir, `reference-style-qa-${stamp}.json`);
  const latestFile = resolve(safeResultsDir, "reference-style-qa-latest.json");
  const reportPath = relative(rootDir, reportFile).replace(/\\/g, "/");
  const latestPath = relative(rootDir, latestFile).replace(/\\/g, "/");
  report.reportPath = reportPath;
  report.latestPath = latestPath;
  assertSafeReport(report);
  atomicWriteJson(reportFile, report);
  atomicWriteJson(latestFile, report);
  return { report, reportPath, latestPath };
}

function safeError(error) {
  return {
    status: "failed",
    passed: false,
    code: error && error.code ? error.code : "REFERENCE_STYLE_QA_FAILED",
    message: error && error.message ? error.message : "Reference style QA failed.",
    report: error?.details?.report || null,
    nextAction: "run-fresh-youtube-proof-visual-goal-qa-then-reference-style-qa",
  };
}

export {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_PROOF_REPORT,
  DEFAULT_VISUAL_QA_REPORT,
  REFERENCE_STYLE_QA_SCHEMA_VERSION,
  ReferenceStyleQAError,
  analyzeGoalPacing,
  analyzeReferenceStyleQA,
  buildReferenceStyleQAReport,
  duplicateRisk,
  parseMaxAgeMs,
  safeError,
  safeRelativeRef,
  scoreProgressionFromContactSheet,
  writeReferenceStyleQA,
};
