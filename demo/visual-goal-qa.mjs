import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSensitiveLeak } from "./report-safety.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_DIR = resolve(ROOT_DIR, "demo", "results");
const DEFAULT_PROOF_REPORT = "demo/results/youtube-live-e2e-latest.json";
const DEFAULT_REPORT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const VISUAL_GOAL_QA_SCHEMA_VERSION = 1;
const REQUIRED_FRAME_ROLES = Object.freeze(["pre_shot", "finish", "payoff", "confirmation"]);
const SCORE_RE = /^(\d{1,2})-(\d{1,2})$/;

class VisualGoalQAError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "VisualGoalQAError";
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

function safeString(value, maxLength = 120) {
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

function safeReasons(values = [], max = 12) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => safeString(value, 100))
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
    return { ok: false, code: "VISUAL_GOAL_QA_REF_UNSAFE", relativePath: null, resolvedFile: null };
  }
  const root = resolve(rootDir || ROOT_DIR);
  const resolvedFile = resolve(root, text);
  if (!isInside(root, resolvedFile)) {
    return { ok: false, code: "VISUAL_GOAL_QA_REF_UNSAFE", relativePath: null, resolvedFile: null };
  }
  return { ok: true, code: null, relativePath: text, resolvedFile };
}

function atomicWriteJson(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function parseMaxAgeMs(value = process.env.SHORTSENGINE_VISUAL_GOAL_QA_MAX_AGE_MS) {
  if (value === undefined || value === null || value === "") return DEFAULT_REPORT_MAX_AGE_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 60_000 || parsed > 24 * 60 * 60 * 1000) {
    throw new VisualGoalQAError("VISUAL_GOAL_QA_MAX_AGE_INVALID", "Visual goal QA max age is invalid.");
  }
  return Math.floor(parsed);
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

function sourceTimeFromRendered(goal = {}, segment = {}, renderedTime = null) {
  const time = Number(renderedTime);
  const timelineStart = Number(goal.timeline && goal.timeline.timelineStart);
  const sourceStart = Number(segment.sourceStart ?? goal.timeline?.sourceStart);
  if (!Number.isFinite(time) || !Number.isFinite(timelineStart) || !Number.isFinite(sourceStart)) return null;
  return round(sourceStart + time - timelineStart);
}

function roleFrame(goal = {}, segment = {}, role) {
  const ref = Array.isArray(goal.frameRefs)
    ? goal.frameRefs.find((frame) => frame && frame.role === role)
    : null;
  if (!ref) {
    return {
      role,
      renderedTimelineTime: null,
      sourceTime: null,
      status: "missing",
      clear: false,
      confidence: null,
      reason: "role_frame_missing",
    };
  }
  const renderedTimelineTime = round(ref.time);
  return {
    role,
    renderedTimelineTime,
    sourceTime: sourceTimeFromRendered(goal, segment, renderedTimelineTime),
    status: safeString(ref.status || "unknown", 40),
    clear: ref.clear === true,
    confidence: round(ref.confidence),
    reason: ref.reason ? safeString(ref.reason, 100) : null,
  };
}

function buildupFrame(segment = {}, goal = {}) {
  const sourceStart = round(segment.sourceStart ?? goal.timeline?.sourceStart);
  const shotStart = round(segment.shotStart);
  return {
    role: "buildup",
    renderedTimelineTime: goal.timeline?.timelineStart == null ? null : round(goal.timeline.timelineStart),
    sourceTime: sourceStart,
    status: segment.phaseCoverage?.hasBuildup === true ? "clear" : "missing",
    clear: segment.phaseCoverage?.hasBuildup === true && sourceStart !== null && shotStart !== null,
    confidence: null,
    reason: segment.phaseCoverage?.hasBuildup === true ? null : "buildup_frame_missing",
  };
}

function segmentByGoalNumber(segments = []) {
  const map = new Map();
  for (const segment of Array.isArray(segments) ? segments : []) {
    const goalNumber = Number(segment && segment.goalNumber);
    if (Number.isFinite(goalNumber) && !map.has(goalNumber)) map.set(goalNumber, segment);
  }
  return map;
}

function buildContactSheet({ proof = {}, generatedAt = nowIso() } = {}) {
  const outputProof = proof.outputProof || {};
  const renderedGoalProof = outputProof.renderedGoalProof || {};
  const goals = Array.isArray(renderedGoalProof.goals) ? renderedGoalProof.goals : [];
  const segments = segmentByGoalNumber(outputProof.segmentWindows || []);
  const contactGoals = goals.map((goal, index) => {
    const goalNumber = Number(goal.goalNumber) || index + 1;
    const segment = segments.get(goalNumber) || {};
    const frames = [
      buildupFrame(segment, goal),
      ...REQUIRED_FRAME_ROLES.map((role) => roleFrame(goal, segment, role)),
    ];
    const missingRoles = frames
      .filter((frame) => frame.clear !== true)
      .map((frame) => frame.role);
    return {
      goalNumber,
      scoreTransition: {
        before: segment.scoreBefore ? safeString(segment.scoreBefore, 16) : null,
        after: segment.scoreAfter ? safeString(segment.scoreAfter, 16) : null,
        scoreChangeTime: round(segment.scoreChangeTime),
      },
      segment: {
        sourceStart: round(segment.sourceStart),
        shotStart: round(segment.shotStart),
        finishTime: round(segment.finishTime),
        confirmationTime: round(segment.confirmationTime),
        sourceEnd: round(segment.sourceEnd),
        durationSeconds: round(Number(segment.sourceEnd) - Number(segment.sourceStart)),
        replayOnly: segment.replayOnly === true,
      },
      renderedTimeline: {
        timelineStart: round(goal.timeline && goal.timeline.timelineStart),
        preShot: round(goal.timeline && goal.timeline.preShot),
        finish: round(goal.timeline && goal.timeline.finish),
        payoff: round(goal.timeline && goal.timeline.payoff),
        confirmation: round(goal.timeline && goal.timeline.confirmation),
        timelineEnd: round(goal.timeline && goal.timeline.timelineEnd),
      },
      verdict: safeString(goal.verdict || "unknown", 40),
      clear: goal.verdict === "clear" && missingRoles.length === 0,
      frames,
      missingRoles,
      failedFrameReasons: safeReasons(goal.failedFrameReasons),
    };
  });
  return {
    schemaVersion: VISUAL_GOAL_QA_SCHEMA_VERSION,
    generatedAt,
    source: {
      sourceType: safeString(proof.source?.sourceType || outputProof.source?.sourceType || "youtube", 40),
      videoId: safeString(proof.source?.videoId || outputProof.source?.videoId, 32),
    },
    outputMp4: {
      relativePath: safeString(outputProof.outputMp4?.relativePath || proof.generatedArtifact?.relativePath, 180),
      durationSeconds: round(outputProof.ffprobe?.durationSeconds || proof.generatedArtifact?.durationSeconds),
      width: Number(outputProof.ffprobe?.width || proof.generatedArtifact?.width) || null,
      height: Number(outputProof.ffprobe?.height || proof.generatedArtifact?.height) || null,
    },
    goalCount: contactGoals.length,
    goals: contactGoals,
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

function scoreProgressionSummary(outputProof = {}, expectedGoalCount = null) {
  const anchors = (Array.isArray(outputProof.scoreChangeAnchors) ? outputProof.scoreChangeAnchors : [])
    .map((anchor, index) => ({
      index: index + 1,
      scoreBefore: safeString(anchor && anchor.scoreBefore, 16),
      scoreAfter: safeString(anchor && anchor.scoreAfter, 16),
      firstSeenAt: round(anchor && anchor.firstSeenAt),
      confirmedAt: round(anchor && anchor.confirmedAt),
    }))
    .filter((anchor) => anchor.scoreBefore && anchor.scoreAfter);
  const transitions = anchors.map((anchor, index) => {
    const previous = index > 0 ? anchors[index - 1] : null;
    const unitIncrease = isUnitIncrease(anchor.scoreBefore, anchor.scoreAfter);
    const chainMatches = !previous || previous.scoreAfter === anchor.scoreBefore;
    return {
      ...anchor,
      transition: `${anchor.scoreBefore} -> ${anchor.scoreAfter}`,
      unitIncrease,
      chainMatches,
      passed: unitIncrease && chainMatches,
    };
  });
  const expected = Number(expectedGoalCount);
  const countMatches = Number.isFinite(expected) ? transitions.length === expected : transitions.length > 0;
  const passed = countMatches && transitions.length > 0 && transitions.every((transition) => transition.passed);
  return {
    passed,
    expectedGoalCount: Number.isFinite(expected) ? expected : null,
    observedTransitionCount: transitions.length,
    transitions,
    reasons: safeReasons([
      ...(!countMatches ? ["score_transition_count_mismatch"] : []),
      ...transitions.filter((transition) => !transition.unitIncrease).map(() => "score_transition_not_unit_increase"),
      ...transitions.filter((transition) => !transition.chainMatches).map(() => "score_transition_chain_mismatch"),
    ]),
  };
}

function scoreFromRatio(count, total) {
  const denominator = Number(total);
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return clampScore((Number(count) / denominator) * 100);
}

function pacingScore(outputProof = {}, contactSheet = {}) {
  const duration = Number(outputProof.ffprobe?.durationSeconds || contactSheet.outputMp4?.durationSeconds);
  const goalCount = Number(contactSheet.goalCount);
  const averageGoalSegmentDuration = Number(outputProof.averageGoalSegmentDuration);
  const totalDurationOk = goalCount >= 5
    ? duration >= 55 && duration <= 125
    : duration > 0;
  const segmentPacingOk = Number.isFinite(averageGoalSegmentDuration)
    ? averageGoalSegmentDuration >= 16 && averageGoalSegmentDuration <= 30
    : true;
  if (totalDurationOk && segmentPacingOk) return 100;
  if (totalDurationOk || segmentPacingOk) return 70;
  return 40;
}

function buildReferenceRubric({ proof = {}, contactSheet = {}, scoreProgression = {} } = {}) {
  const outputProof = proof.outputProof || {};
  const social = outputProof.renderedSocialPolishQA || {};
  const clearGoals = contactSheet.goals.filter((goal) => goal.clear).length;
  const finishClear = contactSheet.goals.filter((goal) => (
    goal.frames.some((frame) => frame.role === "finish" && frame.clear) &&
    goal.frames.some((frame) => frame.role === "payoff" && frame.clear)
  )).length;
  const expected = Number(outputProof.expectedCountedGoals || outputProof.countedGoalsFound || contactSheet.goalCount);
  const fillerPenalty = clampScore(Number(outputProof.nonGoalFillerRate || 0) * 100);
  const replayOnlyPenalty = clampScore(Number(outputProof.replayOnlyGoalRate || 0) * 100);
  const metrics = {
    goalVisibilityScore: scoreFromRatio(clearGoals, expected),
    finishClarityScore: scoreFromRatio(finishClear, expected),
    chronologicalScoreProgressionScore: scoreProgression.passed ? 100 : scoreFromRatio(
      (scoreProgression.transitions || []).filter((transition) => transition.passed).length,
      expected,
    ),
    pacingScore: pacingScore(outputProof, contactSheet),
    hookStrengthScore: social.renderedHook?.passed === true || outputProof.hookFirstTwoSecondsPassed === true ? 100 : 0,
    captionReadabilityScore: social.dynamicCaptions?.passed === true && social.dynamicCaptions?.textObstructionRisk !== true ? 100 : 50,
    captionTimingScore: Number(outputProof.dynamicWordCaptionCount || 0) > 0 && outputProof.openingHookCaptionRendered === true ? 100 : 0,
    transitionSmoothnessScore: social.smoothEditing?.passed === true || Number(outputProof.cutSmoothnessScore) === 1 ? 100 : 50,
    cropSafetyScore: social.renderedActionFraming?.passed === true || outputProof.actionFramingVerdict?.passed === true ? 100 : 50,
    fillerPenalty,
    replayOnlyPenalty,
  };
  const positiveAverage = (
    metrics.goalVisibilityScore * 0.22 +
    metrics.finishClarityScore * 0.18 +
    metrics.chronologicalScoreProgressionScore * 0.14 +
    metrics.pacingScore * 0.1 +
    metrics.hookStrengthScore * 0.08 +
    metrics.captionReadabilityScore * 0.08 +
    metrics.captionTimingScore * 0.08 +
    metrics.transitionSmoothnessScore * 0.06 +
    metrics.cropSafetyScore * 0.06
  );
  metrics.overallHumanWatchabilityScore = clampScore(positiveAverage - metrics.fillerPenalty - metrics.replayOnlyPenalty);
  return metrics;
}

function topFixPriorities({ contactSheet = {}, scoreProgression = {}, rubric = {} } = {}) {
  const priorities = [];
  const failedGoals = contactSheet.goals
    .filter((goal) => goal.clear !== true)
    .map((goal) => goal.goalNumber);
  if (failedGoals.length) priorities.push(`fix_visible_goal_frames_for_goals_${failedGoals.join("_")}`);
  if (!scoreProgression.passed) priorities.push("fix_observed_score_transition_chain");
  if ((rubric.finishClarityScore || 0) < 100) priorities.push("improve_finish_and_payoff_frame_clarity");
  if ((rubric.pacingScore || 0) < 100) priorities.push("tighten_goal_segment_pacing");
  if ((rubric.captionReadabilityScore || 0) < 100 || (rubric.captionTimingScore || 0) < 100) priorities.push("improve_dynamic_caption_readability_and_timing");
  if ((rubric.cropSafetyScore || 0) < 100) priorities.push("improve_crop_and_action_safe_framing");
  if (!priorities.length) {
    priorities.push("manual_side_by_side_review_against_reference_short");
    priorities.push("tune_social_pacing_after_human_review");
    priorities.push("collect_more_reference_style_examples");
  }
  return priorities.slice(0, 3);
}

function failedReasons({ proof = {}, mp4Exists, proofFresh, contactSheet = {}, scoreProgression = {}, rubric = {} } = {}) {
  const outputProof = proof.outputProof || {};
  const expected = Number(outputProof.expectedCountedGoals || outputProof.countedGoalsFound || contactSheet.goalCount);
  const outputRelativePath = String(outputProof.outputMp4?.relativePath || proof.generatedArtifact?.relativePath || "");
  return safeReasons([
    ...(proof.status !== "passed" || proof.passed !== true ? ["source_proof_not_passed"] : []),
    ...(!proofFresh ? ["source_proof_stale"] : []),
    ...(!mp4Exists ? ["output_mp4_missing"] : []),
    ...(/latest|cached|previous/i.test(outputRelativePath) ? ["output_mp4_reference_not_unique"] : []),
    ...(contactSheet.goalCount !== expected ? ["goal_count_mismatch"] : []),
    ...contactSheet.goals.flatMap((goal) => goal.clear ? [] : [`goal_${goal.goalNumber}_frame_refs_not_clear`]),
    ...(!scoreProgression.passed ? scoreProgression.reasons : []),
    ...((rubric.fillerPenalty || 0) > 0 ? ["non_goal_filler_present"] : []),
    ...((rubric.replayOnlyPenalty || 0) > 0 ? ["replay_only_goal_present"] : []),
  ], 18);
}

function visualGoalQAReport({ proof = {}, proofReportPath, outputRef, mp4Stats, contactSheet, contactSheetPath, contactSheetLatestPath, generatedAt = nowIso(), proofFresh = true } = {}) {
  const outputProof = proof.outputProof || {};
  const scoreProgression = scoreProgressionSummary(outputProof, outputProof.expectedCountedGoals || outputProof.countedGoalsFound);
  const rubric = buildReferenceRubric({ proof, contactSheet, scoreProgression });
  const reasons = failedReasons({
    proof,
    mp4Exists: Boolean(outputRef && outputRef.ok && mp4Stats),
    proofFresh,
    contactSheet,
    scoreProgression,
    rubric,
  });
  const passed = reasons.length === 0;
  return {
    schemaVersion: VISUAL_GOAL_QA_SCHEMA_VERSION,
    timestamp: generatedAt,
    generatedAt,
    status: passed ? "passed" : "failed",
    passed,
    phase: "human_visible_goal_qa",
    sourceProofReport: proofReportPath,
    outputMp4: {
      relativePath: outputRef?.relativePath || null,
      sizeBytes: mp4Stats ? mp4Stats.size : null,
      durationSeconds: round(outputProof.ffprobe?.durationSeconds || proof.generatedArtifact?.durationSeconds),
      width: Number(outputProof.ffprobe?.width || proof.generatedArtifact?.width) || null,
      height: Number(outputProof.ffprobe?.height || proof.generatedArtifact?.height) || null,
    },
    contactSheetPath,
    contactSheetLatest: contactSheetLatestPath ? { latestPath: contactSheetLatestPath } : null,
    goalCount: contactSheet.goalCount,
    expectedGoalCount: Number(outputProof.expectedCountedGoals || outputProof.countedGoalsFound || contactSheet.goalCount) || null,
    perGoalVerdict: contactSheet.goals.map((goal) => ({
      goalNumber: goal.goalNumber,
      scoreTransition: goal.scoreTransition,
      verdict: goal.clear ? "clear" : "failed",
      segmentDurationSeconds: goal.segment.durationSeconds,
      framesClear: goal.frames.filter((frame) => frame.clear).length,
      requiredFrameCount: goal.frames.length,
      missingRoles: goal.missingRoles,
    })),
    scoreProgression,
    rubric,
    improvement: {
      baselineCoveredGoalCount: Number(outputProof.baselineCoveredGoalCount) || 0,
      currentCoveredGoalCount: Number(outputProof.newCoveredGoalCount || outputProof.humanVisibleGoalsIncluded || contactSheet.goalCount) || 0,
      improvementDelta: Number(outputProof.improvementDelta) || 0,
    },
    remainingDifferencesFromReference: topFixPriorities({ contactSheet, scoreProgression, rubric }),
    failedReasons: reasons,
    failedCases: passed ? [] : reasons.map((reason) => ({ code: reason })),
    checks: [
      { name: "output_mp4_exists", passed: Boolean(mp4Stats) },
      { name: "output_mp4_unique", passed: !/latest|cached|previous/i.test(String(outputRef?.relativePath || "")) },
      { name: "source_proof_fresh", passed: proofFresh },
      { name: "all_goals_have_clear_frame_refs", passed: contactSheet.goals.every((goal) => goal.clear) },
      { name: "chronological_score_progression", passed: scoreProgression.passed },
      { name: "no_random_filler", passed: (rubric.fillerPenalty || 0) === 0 },
      { name: "no_replay_only_goals", passed: (rubric.replayOnlyPenalty || 0) === 0 },
    ],
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
}

function assertSafeReport(value) {
  const leak = findSensitiveLeak(value);
  if (leak) {
    throw new VisualGoalQAError("VISUAL_GOAL_QA_REPORT_LEAK", "Visual goal QA report contains unsafe data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
}

function analyzeVisualGoalQA({
  rootDir = ROOT_DIR,
  proofReport = DEFAULT_PROOF_REPORT,
  now = nowIso(),
  maxAgeMs = parseMaxAgeMs(),
} = {}) {
  const proofRef = safeRelativeRef(rootDir, proofReport, { requiredPrefix: "demo/results/", extension: ".json" });
  if (!proofRef.ok || !existsSync(proofRef.resolvedFile)) {
    throw new VisualGoalQAError("VISUAL_GOAL_QA_PROOF_MISSING", "Visual goal QA needs an existing safe live proof report.", {
      report: proofRef.relativePath || proofReport,
    });
  }
  const proof = readJsonFile(proofRef.resolvedFile);
  assertSafeReport(proof);
  const proofTime = Date.parse(proof.timestamp || proof.generatedAt || "");
  const nowMs = Date.parse(now);
  const proofFresh = Number.isFinite(proofTime) && Number.isFinite(nowMs) && nowMs - proofTime <= maxAgeMs && proofTime <= nowMs + 5 * 60 * 1000;
  const outputRelativePath = proof.outputProof?.outputMp4?.relativePath || proof.generatedArtifact?.relativePath;
  const outputRef = safeRelativeRef(rootDir, outputRelativePath, { requiredPrefix: "manual-downloads/", extension: ".mp4" });
  const mp4Stats = outputRef.ok && existsSync(outputRef.resolvedFile) ? statSync(outputRef.resolvedFile) : null;
  const contactSheet = buildContactSheet({ proof, generatedAt: now });
  return visualGoalQAReport({
    proof,
    proofReportPath: proofRef.relativePath,
    outputRef,
    mp4Stats,
    contactSheet,
    contactSheetPath: null,
    contactSheetLatestPath: null,
    generatedAt: now,
    proofFresh,
  });
}

function writeVisualGoalQA({
  rootDir = ROOT_DIR,
  proofReport = DEFAULT_PROOF_REPORT,
  resultsDir = null,
  now = nowIso(),
  maxAgeMs = parseMaxAgeMs(),
} = {}) {
  const safeRootDir = resolve(rootDir);
  const proofRef = safeRelativeRef(safeRootDir, proofReport, { requiredPrefix: "demo/results/", extension: ".json" });
  if (!proofRef.ok || !existsSync(proofRef.resolvedFile)) {
    throw new VisualGoalQAError("VISUAL_GOAL_QA_PROOF_MISSING", "Visual goal QA needs an existing safe live proof report.", {
      report: proofRef.relativePath || proofReport,
    });
  }
  const proof = readJsonFile(proofRef.resolvedFile);
  assertSafeReport(proof);
  const outputRelativePath = proof.outputProof?.outputMp4?.relativePath || proof.generatedArtifact?.relativePath;
  const outputRef = safeRelativeRef(safeRootDir, outputRelativePath, { requiredPrefix: "manual-downloads/", extension: ".mp4" });
  const mp4Stats = outputRef.ok && existsSync(outputRef.resolvedFile) ? statSync(outputRef.resolvedFile) : null;
  const proofTime = Date.parse(proof.timestamp || proof.generatedAt || "");
  const nowMs = Date.parse(now);
  const proofFresh = Number.isFinite(proofTime) && Number.isFinite(nowMs) && nowMs - proofTime <= maxAgeMs && proofTime <= nowMs + 5 * 60 * 1000;
  const stamp = stampFromIso(now);
  const safeResultsDir = resolve(safeRootDir, resultsDir || "demo/results");
  const contactSheetFile = resolve(safeResultsDir, `visual-goal-contact-sheet-${stamp}.json`);
  const contactSheetLatestFile = resolve(safeResultsDir, "visual-goal-contact-sheet-latest.json");
  const reportFile = resolve(safeResultsDir, `visual-goal-qa-${stamp}.json`);
  const latestFile = resolve(safeResultsDir, "visual-goal-qa-latest.json");
  const contactSheetPath = relative(safeRootDir, contactSheetFile).replace(/\\/g, "/");
  const contactSheetLatestPath = relative(safeRootDir, contactSheetLatestFile).replace(/\\/g, "/");
  const reportPath = relative(safeRootDir, reportFile).replace(/\\/g, "/");
  const latestPath = relative(safeRootDir, latestFile).replace(/\\/g, "/");
  const contactSheet = buildContactSheet({ proof, generatedAt: now });
  contactSheet.reportPath = contactSheetPath;
  assertSafeReport(contactSheet);
  const report = visualGoalQAReport({
    proof,
    proofReportPath: proofRef.relativePath,
    outputRef,
    mp4Stats,
    contactSheet,
    contactSheetPath,
    contactSheetLatestPath,
    generatedAt: now,
    proofFresh,
  });
  report.reportPath = reportPath;
  report.latestPath = latestPath;
  assertSafeReport(report);
  atomicWriteJson(contactSheetFile, contactSheet);
  atomicWriteJson(contactSheetLatestFile, contactSheet);
  atomicWriteJson(reportFile, report);
  atomicWriteJson(latestFile, report);
  return { report, reportPath, latestPath, contactSheetPath, contactSheetLatestPath };
}

function safeError(error) {
  return {
    status: "failed",
    passed: false,
    code: error && error.code ? error.code : "VISUAL_GOAL_QA_FAILED",
    message: error && error.message ? error.message : "Visual goal QA failed.",
    report: error?.details?.report || null,
    nextAction: "run-fresh-youtube-proof-then-npm-run-visual-goal-qa",
  };
}

export {
  DEFAULT_PROOF_REPORT,
  DEFAULT_REPORT_MAX_AGE_MS,
  REQUIRED_FRAME_ROLES,
  VISUAL_GOAL_QA_SCHEMA_VERSION,
  VisualGoalQAError,
  analyzeVisualGoalQA,
  buildContactSheet,
  parseMaxAgeMs,
  scoreProgressionSummary,
  safeError,
  safeRelativeRef,
  visualGoalQAReport,
  writeVisualGoalQA,
};
