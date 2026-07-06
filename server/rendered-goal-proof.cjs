const { randomUUID } = require("node:crypto");
const { mkdirSync } = require("node:fs");
const { join, relative } = require("node:path");
const { sanitizeText } = require("./media.cjs");
const { extractSampledFrames, publicFrameSummary } = require("./frame-extraction.cjs");
const { analyzeSemanticGoalFrames } = require("./semantic-goal-visibility.cjs");
const { safeResolve, storagePath, writeJsonAtomic } = require("./storage.cjs");

const MAX_GOALS = 8;
const FRAME_ROLES = Object.freeze(["pre_shot", "finish", "payoff", "confirmation"]);
const ROLE_HINT_PREFIX = "goal_role:";
const FINISH_FRAME_CODES = Object.freeze(["rendered_finish_frame_visible", "finish_frame_visible", "ball_in_net_or_payoff_visible"]);

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

function safeCodes(values = [], max = 12) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => sanitizeText(value, 80))
    .filter(Boolean))]
    .slice(0, max);
}

function isConfirmedGoalSegment(segment = {}) {
  return segment.highlightType === "goal" &&
    segment.goalOutcome &&
    segment.goalOutcome.eventType === "ball_in_net" &&
    segment.goalOutcome.outcome === "confirmed_goal";
}

function segmentTimeline(segment = {}, fallbackStart = 0) {
  const sourceStart = numberOrNull(segment.sourceStart) ?? 0;
  const sourceEnd = numberOrNull(segment.sourceEnd) ?? sourceStart;
  const duration = Math.max(0.1, numberOrNull(segment.duration) ?? sourceEnd - sourceStart);
  const timelineStart = numberOrNull(segment.timelineStart) ?? fallbackStart;
  const timelineEnd = numberOrNull(segment.timelineEnd) ?? timelineStart + duration;
  const localTime = (sourceTime, fallbackOffset = 0) => {
    const parsed = numberOrNull(sourceTime);
    if (parsed == null) return round(timelineStart + fallbackOffset);
    return round(Math.min(timelineEnd, Math.max(timelineStart, timelineStart + parsed - sourceStart)));
  };
  const shot = localTime(segment.shotStart, Math.min(4, duration * 0.35));
  const finish = localTime(segment.finishTime, Math.min(duration - 0.8, Math.max(shot + 1, duration * 0.65)));
  const confirmation = localTime(segment.confirmationTime, Math.min(duration - 0.2, Math.max(finish + 0.4, duration * 0.82)));
  return {
    sourceStart: round(sourceStart),
    sourceEnd: round(sourceEnd),
    duration: round(duration),
    timelineStart: round(timelineStart),
    timelineEnd: round(timelineEnd),
    preShot: round(Math.max(timelineStart + 0.15, Math.min(shot - 0.75, finish - 2))),
    shot,
    finish,
    payoff: round(Math.min(timelineEnd - 0.15, Math.max(finish + 0.55, finish))),
    confirmation,
  };
}

function hasStrongSourceGoalEvidence(segment = {}) {
  const phase = segment.phaseCoverage && typeof segment.phaseCoverage === "object" && !Array.isArray(segment.phaseCoverage)
    ? segment.phaseCoverage
    : {};
  const payoff = phase.visualGoalPayoff && typeof phase.visualGoalPayoff === "object" && !Array.isArray(phase.visualGoalPayoff)
    ? phase.visualGoalPayoff
    : {};
  const codes = new Set(safeCodes([
    ...(Array.isArray(segment.reasonCodes) ? segment.reasonCodes : []),
    ...(Array.isArray(payoff.evidenceCodes) ? payoff.evidenceCodes : []),
  ], 24));
  const hasShot = phase.hasShot === true &&
    (codes.has("visual_shot_contact") || codes.has("visual_ball_toward_goal") || codes.has("shot_sequence_support"));
  const hasFinish = phase.hasFinish === true &&
    (
      codes.has("visual_ball_in_net") ||
      codes.has("ball_in_net") ||
      codes.has("live_shot_finish_sequence") ||
      payoff.hasLiveFinishSequence === true
    );
  const hasConfirmation = phase.hasConfirmation === true &&
    (codes.has("scoreboard_ocr_score_change") || codes.has("scoreboard_temporal_consistency") || codes.has("visual_scoreboard_goal_confirmed"));
  const disallowedShape = segment.replayOnly === true ||
    phase.replayOnly === true ||
    segment.celebrationOnly === true ||
    phase.celebrationOnly === true;
  return isConfirmedGoalSegment(segment) && !disallowedShape && phase.hasBuildup === true && hasShot && hasFinish && hasConfirmation;
}

function frameWindowsForGoal(segment = {}, timeline = {}) {
  const goalNumber = numberOrNull(segment.goalNumber);
  const duration = Math.max(0.1, Number(timeline.timelineEnd) - Number(timeline.timelineStart));
  const shotTime = numberOrNull(timeline.shot);
  const finishTime = numberOrNull(timeline.finish);
  const confirmationTime = numberOrNull(timeline.confirmation);
  const candidateGroups = [
    ["pre_shot", [
      Number(timeline.timelineStart) + 0.4,
      Number(timeline.preShot) - 2.2,
      Number(timeline.preShot) - 0.9,
      Number(timeline.preShot),
      Number(timeline.shot) - 1,
      Number(timeline.shot) - 0.35,
    ]],
    ["finish", [
      Number(timeline.finish) - 6,
      Number(timeline.finish) - 4.5,
      Number(timeline.finish) - 3,
      Number(timeline.finish) - 2,
      Number(timeline.finish) - 1.35,
      Number(timeline.finish) - 0.65,
      Number(timeline.finish),
      Number(timeline.finish) + 0.55,
    ]],
    ["payoff", [
      Number(timeline.payoff),
      Number(timeline.finish) + 1.15,
      Number(timeline.finish) + 2.25,
      Number(timeline.finish) + 3.5,
      Number(timeline.finish) + 4.7,
      Number(timeline.confirmation) - 0.45,
    ]],
    ["confirmation", [
      Number(timeline.confirmation),
      Number(timeline.confirmation) + 0.65,
      Number(timeline.confirmation) + 1.3,
      Number(timeline.timelineEnd) - 0.25,
    ]],
  ];
  const minTime = Math.max(0, Number(timeline.timelineStart) + 0.08);
  const maxTime = Math.max(minTime + 0.1, Number(timeline.timelineEnd) - 0.08);
  const roleTimeAllowed = (role, time) => {
    const parsed = Number(time);
    if (!Number.isFinite(parsed)) return false;
    if (role === "finish") {
      if (shotTime != null && parsed < shotTime - 0.25) return false;
      if (finishTime != null && parsed < finishTime - 2.5) return false;
      if (confirmationTime != null && parsed > confirmationTime + 0.25) return false;
    }
    if (role === "payoff") {
      if (finishTime != null && parsed < finishTime - 0.1) return false;
      if (confirmationTime != null && parsed > confirmationTime + 0.25) return false;
    }
    if (role === "confirmation" && finishTime != null && parsed < finishTime - 0.25) return false;
    return true;
  };
  const seen = new Set();
  return candidateGroups
    .flatMap(([role, times]) => times
      .filter((time) => Number.isFinite(Number(time)))
      .map((time) => Math.min(maxTime, Math.max(minTime, Number(time))))
      .filter((time) => roleTimeAllowed(role, time))
      .map((time) => {
        const rounded = round(time);
        const key = `${role}:${rounded}`;
        if (seen.has(key)) return null;
        seen.add(key);
        const roleBoost = role === "finish" ? 0.06 : role === "payoff" ? 0.03 : 0;
        return {
          time: rounded,
          start: round(Math.max(0, Number(rounded) - 0.08)),
          end: round(Number(rounded) + 0.08),
          confidence: round(Math.min(0.95, 0.84 + roleBoost + Math.min(0.05, duration / 500))),
          source: "rendered_goal_visibility_rebind",
          visualHints: [role, `${ROLE_HINT_PREFIX}${role}`, "rendered_goal_proof"],
          role,
          goalNumber,
        };
      })
      .filter(Boolean))
    .sort((a, b) => Number(a.time) - Number(b.time));
}

function publicFrameRef(frame = {}, role = "", time = null) {
  const semantic = semanticFrameVisibility(frame, role);
  return {
    role: sanitizeText(role, 40),
    time: round(time ?? frame.timestamp),
    status: frame && frame.localPath ? semantic.status : "missing",
    clear: Boolean(frame && frame.localPath && semantic.clear),
    frameId: sanitizeText(frame && frame.id || "", 64) || null,
    width: numberOrNull(frame && frame.width),
    height: numberOrNull(frame && frame.height),
    confidence: semantic.confidence,
    reason: semantic.reason,
  };
}

function evidenceObject(frame = {}) {
  const candidates = [
    frame.semanticGoalEvidence,
    frame.goalVisibility,
    frame.goalEvidence,
    frame.renderedGoalEvidence,
    frame.visibilityEvidence,
  ];
  return candidates.find((value) => value && typeof value === "object" && !Array.isArray(value)) || {};
}

function semanticFrameVisibility(frame = {}, role = "") {
  const evidence = evidenceObject(frame);
  const verdict = sanitizeText(
    evidence.visibilityVerdict || evidence.verdict || frame.visibilityVerdict || "",
    32,
  ).toLowerCase();
  const roles = Array.isArray(evidence.roles)
    ? evidence.roles.map((value) => sanitizeText(value, 40)).filter(Boolean)
    : [];
  const roleCovered = roles.length === 0 || roles.includes(role);
  const hasExplicitGoalEvidence = evidence.visibleGoal === true ||
    evidence.goalVisible === true ||
    evidence.hasVisibleFinish === true ||
    evidence.hasBallInNetOrPayoff === true ||
    evidence.ballInNetOrPayoffVisible === true ||
    evidence.hasClearPayoff === true;
  const forbidden = evidence.replayOnly === true ||
    evidence.celebrationOnly === true ||
    evidence.scoreboardOnly === true ||
    evidence.playerCloseupOnly === true ||
    evidence.labelOnly === true ||
    evidence.blurred === true ||
    evidence.overZoomed === true;
  const semanticClear = verdict === "clear" && roleCovered && hasExplicitGoalEvidence && !forbidden;
  const confidence = numberOrNull(evidence.confidence);
  if (semanticClear) return { clear: true, status: "clear", reason: null, confidence };
  if (!Object.keys(evidence).length) {
    return { clear: false, status: "unverified", reason: "semantic_frame_validation_missing", confidence };
  }
  if (!roleCovered) return { clear: false, status: "failed", reason: "semantic_frame_role_mismatch", confidence };
  if (forbidden) return { clear: false, status: "failed", reason: "semantic_frame_forbidden_content", confidence };
  if (verdict !== "clear") return { clear: false, status: "failed", reason: "semantic_frame_not_clear", confidence };
  return { clear: false, status: "failed", reason: "semantic_goal_evidence_missing", confidence };
}

function roleFromFrameHints(frame = {}, fallbackRole = "") {
  const hints = Array.isArray(frame.visualHints) ? frame.visualHints : [];
  const roleHint = hints.find((hint) => sanitizeText(hint, 64).startsWith(ROLE_HINT_PREFIX));
  if (!roleHint) return sanitizeText(fallbackRole, 40);
  return sanitizeText(roleHint.slice(ROLE_HINT_PREFIX.length), 40) || sanitizeText(fallbackRole, 40);
}

function candidateFrameRefs({ frames = [], windows = [] } = {}) {
  return (Array.isArray(frames) ? frames : []).map((frame, index) => {
    const window = Array.isArray(windows) ? windows[index] : null;
    const role = roleFromFrameHints(frame, window && window.role);
    return publicFrameRef(frame, role, window && window.time);
  });
}

function missingFrameRef(role) {
  return {
    role: sanitizeText(role, 40),
    time: null,
    status: "missing",
    clear: false,
    frameId: null,
    width: null,
    height: null,
    confidence: null,
    reason: "role_frame_missing",
  };
}

function timelineTimeOrNull(timeline = {}, key = "") {
  return numberOrNull(timeline && timeline[key]);
}

function canPayoffSatisfyFinish(payoffRef = {}, timeline = {}) {
  if (!payoffRef || payoffRef.clear !== true) return false;
  const payoffTime = numberOrNull(payoffRef.time);
  const shotTime = timelineTimeOrNull(timeline, "shot");
  const finishTime = timelineTimeOrNull(timeline, "finish");
  const confirmationTime = timelineTimeOrNull(timeline, "confirmation");
  if (payoffTime == null || finishTime == null) return false;
  if (shotTime != null && payoffTime < shotTime - 0.25) return false;
  if (payoffTime < finishTime - 2.5) return false;
  if (confirmationTime != null && payoffTime > confirmationTime + 0.25) return false;
  return true;
}

function selectBestFrameRefs(candidates = [], timeline = {}) {
  const selected = FRAME_ROLES.map((role) => {
    const roleCandidates = (Array.isArray(candidates) ? candidates : [])
      .filter((frame) => frame.role === role);
    if (!roleCandidates.length) return missingFrameRef(role);
    return roleCandidates
      .sort((a, b) => {
        if (Boolean(a.clear) !== Boolean(b.clear)) return a.clear ? -1 : 1;
        const confidenceDelta = (numberOrNull(b.confidence) ?? 0) - (numberOrNull(a.confidence) ?? 0);
        if (Math.abs(confidenceDelta) > 0.0001) return confidenceDelta;
        if (a.status !== b.status) return a.status === "failed" ? 1 : -1;
        return (numberOrNull(a.time) ?? 0) - (numberOrNull(b.time) ?? 0);
      })[0];
  });
  const finishRef = selected.find((frame) => frame.role === "finish");
  const payoffIndex = selected.findIndex((frame) => frame.role === "payoff");
  const payoffRef = payoffIndex >= 0 ? selected[payoffIndex] : null;
  if (finishRef && finishRef.clear === true && payoffRef && payoffRef.clear !== true) {
    selected[payoffIndex] = {
      ...finishRef,
      role: "payoff",
      satisfiedByRole: "finish",
      reason: null,
    };
  }
  const finishIndex = selected.findIndex((frame) => frame.role === "finish");
  const selectedPayoffRef = payoffIndex >= 0 ? selected[payoffIndex] : null;
  const selectedFinishRef = finishIndex >= 0 ? selected[finishIndex] : null;
  if (
    selectedFinishRef &&
    selectedFinishRef.clear !== true &&
    canPayoffSatisfyFinish(selectedPayoffRef, timeline)
  ) {
    selected[finishIndex] = {
      ...selectedPayoffRef,
      role: "finish",
      satisfiedByRole: "payoff",
      reason: null,
    };
  }
  return selected;
}

function contactSheetRef(contactSheetPath = null) {
  if (!contactSheetPath) return null;
  const ref = relative(process.cwd(), contactSheetPath).replace(/\\/g, "/");
  if (!ref || ref.startsWith("..") || ref.startsWith("/") || ref.includes("\0")) return null;
  return ref;
}

async function extractRenderedGoalFrames({
  outputPath,
  metadata,
  windows,
  extractFrames,
  signal,
  outputDir,
} = {}) {
  if (!windows.length) {
    return { providerMode: "rendered-goal-proof-empty", fallbackUsed: true, frames: [], summary: { frameCount: 0 } };
  }
  return extractFrames({
    inputPath: outputPath,
    metadata,
    candidateWindows: windows,
    outputDir,
    maxFrames: Math.min(24, Math.max(1, windows.length)),
    maxDimension: 480,
    signal,
  });
}

function attachEvidenceToSegment(segment = {}, evidence = {}) {
  const phase = segment.phaseCoverage && typeof segment.phaseCoverage === "object" && !Array.isArray(segment.phaseCoverage)
    ? segment.phaseCoverage
    : {};
  const visualGoalPayoff = phase.visualGoalPayoff && typeof phase.visualGoalPayoff === "object" && !Array.isArray(phase.visualGoalPayoff)
    ? phase.visualGoalPayoff
    : {};
  const mergedPayoff = { ...visualGoalPayoff, finishFrameEvidence: evidence };
  const mergedPhase = {
    ...phase,
    visualGoalPayoff: mergedPayoff,
    finishFrameEvidence: evidence,
  };
  return {
    ...segment,
    phaseCoverage: mergedPhase,
    finishFrameEvidence: evidence,
  };
}

async function analyzeRenderedGoalProof({
  outputPath,
  editPlan,
  signal = null,
  extractFrames = extractSampledFrames,
  semanticAnalyzer = analyzeSemanticGoalFrames,
  writeJson = writeJsonAtomic,
} = {}) {
  const segments = Array.isArray(editPlan && editPlan.segments) ? editPlan.segments : [];
  let cursor = 0;
  const runId = `rendered-goal-proof-${randomUUID()}`;
  const proofDir = storagePath("staging", join("rendered-goal-proof", runId));
  mkdirSync(proofDir, { recursive: true });
  const proofGoals = [];
  const updatedSegments = [];
  for (const [index, segment] of segments.entries()) {
    const duration = Math.max(0, Number(segment.duration || Number(segment.sourceEnd) - Number(segment.sourceStart)) || 0);
    if (!isConfirmedGoalSegment(segment)) {
      updatedSegments.push(segment);
      cursor += duration;
      continue;
    }
    const timeline = segmentTimeline(segment, cursor);
    const windows = frameWindowsForGoal(segment, timeline);
    const goalOutputDir = safeResolve(proofDir, `goal_${String(index + 1).padStart(2, "0")}`);
    const extracted = await extractRenderedGoalFrames({
      outputPath,
      metadata: {
        durationSeconds: Number(editPlan.totalDuration || timeline.timelineEnd || 0),
        width: editPlan.export && editPlan.export.width,
        height: editPlan.export && editPlan.export.height,
      },
      windows,
      extractFrames,
      signal,
      outputDir: goalOutputDir,
    });
    const frames = Array.isArray(extracted && extracted.frames) ? extracted.frames : [];
    const roleWindows = frames.map((frame, frameIndex) => ({
      ...(windows[frameIndex] || {}),
      role: roleFromFrameHints(frame, windows[frameIndex] && windows[frameIndex].role),
    }));
    const semantic = await semanticAnalyzer({
      frames,
      roleWindows,
      segment,
      timeline,
      signal,
    });
    const frameEvidence = Array.isArray(semantic && semantic.frameEvidence) ? semantic.frameEvidence : [];
    const semanticFrames = frames.map((frame, frameIndex) => ({
      ...frame,
      semanticGoalEvidence: frameEvidence[frameIndex] || frame.semanticGoalEvidence || null,
    }));
    const candidateRefs = candidateFrameRefs({ frames: semanticFrames, windows });
    const frameRefs = selectBestFrameRefs(candidateRefs, timeline);
    const selectedFinishRef = frameRefs.find((frame) => frame.role === "finish" && frame.clear === true);
    const selectedFinishSourceTime = selectedFinishRef && numberOrNull(selectedFinishRef.time) != null
      ? round(Number(timeline.sourceStart) + Number(selectedFinishRef.time) - Number(timeline.timelineStart))
      : null;
    const frameCount = frameRefs.filter((frame) => frame.clear).length;
    const unverifiedFrameCount = frameRefs.filter((frame) => frame.status === "unverified").length;
    const failedFrameReasons = safeCodes(frameRefs
      .filter((frame) => frame.clear !== true)
      .map((frame) => frame.reason || `${frame.role}_not_clear`), 12);
    const strongSourceEvidence = hasStrongSourceGoalEvidence(segment);
    const clear = strongSourceEvidence && frameCount >= 4;
    const borderline = !clear && strongSourceEvidence && frameCount >= 2;
    const evidence = {
      frameTime: selectedFinishSourceTime ?? numberOrNull(segment.finishTime) ?? timeline.finish,
      confidence: clear ? 0.88 : borderline ? 0.62 : 0.2,
      visibilityVerdict: clear ? "clear" : borderline ? "borderline" : "failed",
      hasVisibleFinish: clear,
      hasBallInNetOrPayoff: clear,
      hasGoalMouth: clear || borderline,
      hasPreShotActionFrame: frameRefs.some((frame) => frame.role === "pre_shot" && frame.clear),
      hasFinishActionFrame: frameRefs.some((frame) => frame.role === "finish" && frame.clear),
      hasPayoffFrame: frameRefs.some((frame) => frame.role === "payoff" && frame.clear),
      hasConfirmationFrame: frameRefs.some((frame) => frame.role === "confirmation" && frame.clear),
      continuousActionFrameCount: frameCount,
      supportFrames: frameRefs,
      isBlurred: false,
      isOverZoomed: false,
      isLabelOnly: false,
      isReplayOnly: segment.replayOnly === true || (segment.phaseCoverage && segment.phaseCoverage.replayOnly === true),
      isCelebrationOnly: segment.celebrationOnly === true || (segment.phaseCoverage && segment.phaseCoverage.celebrationOnly === true),
      isScoreboardOnly: false,
      isPlayerCloseupOnly: false,
      isFrameTooWideUnclear: false,
      evidenceCodes: clear ? FINISH_FRAME_CODES : ["rendered_frame_samples_semantically_unverified"],
      proofMethod: "rendered_timeline_frame_sampling",
      semanticFrameValidationRequired: true,
      semanticFrameValidationPassed: clear,
      unverifiedFrameCount,
      reasons: failedFrameReasons,
      candidateFrameCount: candidateRefs.length,
    };
    const updatedSegment = attachEvidenceToSegment(segment, evidence);
    updatedSegments.push(updatedSegment);
    proofGoals.push({
      goalNumber: numberOrNull(segment.goalNumber) || index + 1,
      segmentIndex: index + 1,
      segmentId: sanitizeText(segment.id || `segment_${index + 1}`, 80),
      verdict: evidence.visibilityVerdict,
      timeline,
      frameCount,
      frameRefs,
      candidateFrameCount: candidateRefs.length,
      sourceEvidenceStrong: strongSourceEvidence,
      unverifiedFrameCount,
      failedFrameReasons,
      semanticSummary: semantic
        ? {
            providerMode: sanitizeText(semantic.providerMode || "semantic-goal-visibility", 80),
            clearFrameCount: numberOrNull(semantic.clearFrameCount),
            failedFrameCount: numberOrNull(semantic.failedFrameCount),
          }
        : null,
      existingClearProofUsed: false,
      extraction: publicFrameSummary(extracted),
    });
    cursor += duration;
  }
  const contactSheetPath = safeResolve(proofDir, "contact-sheet.json");
  const summary = {
    schemaVersion: 1,
    providerMode: "rendered-goal-proof",
    outputRef: outputPath ? "rendered_output" : null,
    goalCount: proofGoals.length,
    clearGoalCount: proofGoals.filter((goal) => goal.verdict === "clear").length,
    borderlineGoalCount: proofGoals.filter((goal) => goal.verdict === "borderline").length,
    failedGoalCount: proofGoals.filter((goal) => goal.verdict === "failed").length,
    contactSheetRef: contactSheetRef(contactSheetPath),
    goals: proofGoals.map((goal) => ({
      goalNumber: goal.goalNumber,
      segmentIndex: goal.segmentIndex,
      verdict: goal.verdict,
      timeline: goal.timeline,
      frameCount: goal.frameCount,
      frameRefs: goal.frameRefs,
      candidateFrameCount: goal.candidateFrameCount,
      sourceEvidenceStrong: goal.sourceEvidenceStrong,
      unverifiedFrameCount: goal.unverifiedFrameCount,
      failedFrameReasons: goal.failedFrameReasons,
      semanticSummary: goal.semanticSummary,
      existingClearProofUsed: goal.existingClearProofUsed,
    })),
    logsDownloaded: false,
    artifactsDownloaded: false,
  };
  writeJson(contactSheetPath, summary);
  return {
    editPlan: { ...editPlan, segments: updatedSegments, renderedGoalProof: summary },
    summary,
  };
}

module.exports = {
  analyzeRenderedGoalProof,
};
