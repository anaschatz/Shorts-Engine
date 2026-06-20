const { AppError, SAFE_MESSAGES } = require("./errors.cjs");
const { sanitizeText } = require("./media.cjs");

const MAX_REASON_CODES = 8;
const DEFAULT_MIN_CONFIDENCE = 0.74;
const SENSITIVE_RE = /\/Users\/|\/private\/|storageKey|localPath|fullPath|absolutePath|Bearer\s+|OPENAI_API_KEY|api[_-]?key|token|secret|stderr|stdout|rawOcr|rawText/i;

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function hasUnsafeValue(value) {
  try {
    return SENSITIVE_RE.test(JSON.stringify(value || {}));
  } catch {
    return true;
  }
}

function uniqueReasons(reasons = []) {
  return [...new Set((Array.isArray(reasons) ? reasons : [reasons])
    .map((reason) => sanitizeText(reason, 80))
    .filter(Boolean)
    .filter((reason) => !SENSITIVE_RE.test(reason)))]
    .slice(0, MAX_REASON_CODES);
}

function scoreText(score = {}) {
  if (!Number.isInteger(score.home) || !Number.isInteger(score.away)) return null;
  return `${score.home}-${score.away}`;
}

function normalizeScore(score = {}) {
  if (!score || typeof score !== "object" || Array.isArray(score) || hasUnsafeValue(score)) return null;
  const home = Number(score.home);
  const away = Number(score.away);
  if (!Number.isInteger(home) || !Number.isInteger(away)) return null;
  if (home < 0 || away < 0 || home > 9 || away > 9 || home + away > 12) return null;
  return { home, away, text: `${home}-${away}` };
}

function normalizeScoreText(value = "") {
  return sanitizeText(String(value || "")
    .replace(/[–—]/g, "-")
    .replace(/[|]/g, "I")
    .replace(/\s+/g, " "), 160);
}

function digitFromOcrToken(value, { allowContextLetters = false } = {}) {
  const token = String(value || "");
  if (/^[0-9]$/.test(token)) return token;
  if (!allowContextLetters) return null;
  if (/^[Oo]$/.test(token)) return "0";
  if (/^[Il]$/.test(token)) return "1";
  return null;
}

function parseScorebugDigitGroups(text, { allowContextLetters = true } = {}) {
  const safe = normalizeScoreText(text);
  if (!safe) {
    return {
      score: null,
      status: "unreadable",
      reasonCodes: ["scorebug_text_empty"],
      normalizedText: "",
    };
  }
  if (/\b(?:[0-2]?\d:)?[0-5]?\d:[0-5]\d\b/.test(safe)) {
    return {
      score: null,
      status: "rejected_clock",
      reasonCodes: ["clock_like_text_rejected"],
      normalizedText: safe,
    };
  }
  const nonScoreLetters = safe.replace(/[0-9OoIl\s_.:-]/g, "");
  if (/[A-Z]/i.test(nonScoreLetters)) {
    return {
      score: null,
      status: "rejected_team_text",
      reasonCodes: ["team_label_or_noise_rejected"],
      normalizedText: safe,
    };
  }
  const digitLike = safe.match(/[0-9OoIl]/g) || [];
  if (digitLike.length !== 2) {
    return {
      score: null,
      status: digitLike.length > 2 ? "rejected_noise" : "unreadable",
      reasonCodes: [digitLike.length > 2 ? "extra_digit_groups_rejected" : "two_digit_groups_missing"],
      normalizedText: safe,
    };
  }
  const homeText = digitFromOcrToken(digitLike[0], { allowContextLetters });
  const awayText = digitFromOcrToken(digitLike[1], { allowContextLetters });
  const home = Number(homeText);
  const away = Number(awayText);
  const score = normalizeScore({ home, away });
  if (!score) {
    return {
      score: null,
      status: "rejected_noise",
      reasonCodes: ["score_value_out_of_bounds"],
      normalizedText: safe,
    };
  }
  return {
    score,
    status: "accepted",
    reasonCodes: [],
    normalizedText: safe,
  };
}

function scoreTotal(score = {}) {
  return Number(score.home || 0) + Number(score.away || 0);
}

function scoreDelta(before, after) {
  if (!before || !after) return 0;
  return Math.abs(after.home - before.home) + Math.abs(after.away - before.away);
}

function scorebugTransitionDecision({ previousScore = null, candidateScore = null, confidence = 0, minConfidence = DEFAULT_MIN_CONFIDENCE } = {}) {
  const before = normalizeScore(previousScore);
  const after = normalizeScore(candidateScore);
  const safeConfidence = round(clamp(confidence, 0, 1));
  const threshold = round(clamp(minConfidence || DEFAULT_MIN_CONFIDENCE, 0.55, 0.98));
  if (!after) {
    return {
      decision: "unreadable",
      accepted: false,
      reasonCodes: ["score_candidate_missing"],
      confidence: safeConfidence,
    };
  }
  if (safeConfidence < threshold) {
    return {
      decision: "rejected_low_confidence",
      accepted: false,
      reasonCodes: ["score_confidence_below_threshold"],
      confidence: safeConfidence,
    };
  }
  if (!before) {
    return {
      decision: "initial_score",
      accepted: true,
      reasonCodes: ["initial_score_observed"],
      confidence: safeConfidence,
    };
  }
  const delta = scoreDelta(before, after);
  if (delta === 0) {
    return {
      decision: "score_unchanged",
      accepted: true,
      reasonCodes: ["score_stable_repeat"],
      confidence: safeConfidence,
    };
  }
  if (delta !== 1) {
    return {
      decision: "rejected_impossible_transition",
      accepted: false,
      reasonCodes: ["impossible_or_non_unit_score_transition"],
      confidence: safeConfidence,
    };
  }
  const totalDelta = scoreTotal(after) - scoreTotal(before);
  if (totalDelta === 1) {
    return {
      decision: "score_changed",
      accepted: true,
      reasonCodes: ["unit_score_increase_candidate"],
      confidence: safeConfidence,
    };
  }
  if (totalDelta === -1) {
    return {
      decision: "score_reverted_or_disallowed",
      accepted: true,
      reasonCodes: ["score_decrease_disallowed_context"],
      confidence: safeConfidence,
    };
  }
  return {
    decision: "rejected_impossible_transition",
    accepted: false,
    reasonCodes: ["ambiguous_score_transition"],
    confidence: safeConfidence,
  };
}

function candidateCountsFromDigitReading(digitReading = {}) {
  const segmentation = digitReading && digitReading.imageSegmentation && typeof digitReading.imageSegmentation === "object"
    ? digitReading.imageSegmentation
    : {};
  return {
    homeCandidateGroups: Array.isArray(segmentation.homeDigitCandidates) ? segmentation.homeDigitCandidates.length : 0,
    awayCandidateGroups: Array.isArray(segmentation.awayDigitCandidates) ? segmentation.awayDigitCandidates.length : 0,
    foregroundGroupCount: Math.max(0, Math.min(99, Number(segmentation.foregroundGroupCount || 0))),
  };
}

function buildScorebugAttemptDiagnostic({
  layoutId = null,
  regionId = null,
  score = null,
  scoreOnlyText = "",
  ocrText = "",
  clock = null,
  confidence = 0,
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  source = null,
  digitReading = null,
  previousScore = null,
} = {}) {
  const safeScore = normalizeScore(score);
  const parsedScoreOnly = scoreOnlyText ? parseScorebugDigitGroups(scoreOnlyText) : null;
  const parsedFull = !safeScore && ocrText ? parseScorebugDigitGroups(ocrText, { allowContextLetters: false }) : null;
  const scoreCandidate = safeScore || (parsedScoreOnly && parsedScoreOnly.score) || (parsedFull && parsedFull.score) || null;
  const safeConfidence = round(clamp(confidence, 0, 1));
  const transition = scorebugTransitionDecision({
    previousScore,
    candidateScore: scoreCandidate,
    confidence: safeConfidence,
    minConfidence,
  });
  const digitReasons = Array.isArray(digitReading && digitReading.reasons) ? digitReading.reasons : [];
  const parseReasons = [
    ...(parsedScoreOnly ? parsedScoreOnly.reasonCodes : []),
    ...(parsedFull ? parsedFull.reasonCodes : []),
  ];
  let transitionDecision = transition.decision;
  const rejectedReasonCodes = [];
  if ([parsedScoreOnly && parsedScoreOnly.status, parsedFull && parsedFull.status].includes("rejected_team_text")) {
    transitionDecision = "rejected_team_text";
    rejectedReasonCodes.push("team_label_or_noise_rejected");
  } else if (clock && !scoreCandidate) {
    transitionDecision = "rejected_clock";
    rejectedReasonCodes.push("clock_like_text_rejected");
  } else if (transition.accepted === false) {
    rejectedReasonCodes.push(...transition.reasonCodes);
  }
  const counts = candidateCountsFromDigitReading(digitReading);
  const reasonCodes = uniqueReasons([
    ...parseReasons,
    ...digitReasons,
    ...transition.reasonCodes,
    ...rejectedReasonCodes,
  ]);
  return {
    layoutId: layoutId ? sanitizeText(layoutId, 80) : null,
    selectedProfile: layoutId ? sanitizeText(layoutId, 80) : null,
    regionId: regionId ? sanitizeText(regionId, 80) : null,
    source: source ? sanitizeText(source, 80) : null,
    finalScoreCandidate: scoreCandidate ? scoreCandidate.text : null,
    confidence: safeConfidence,
    transitionDecision,
    accepted: transition.accepted && !rejectedReasonCodes.length,
    rejectedReasonCodes: uniqueReasons(rejectedReasonCodes),
    reasonCodes,
    digitBoxesFound: Array.isArray(digitReading && digitReading.digitBoxes)
      ? Math.max(0, Math.min(20, digitReading.digitBoxes.length))
      : 0,
    ...counts,
  };
}

function safeScorebugAttemptDiagnostic(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || hasUnsafeValue(value)) {
    throw new AppError("AI_OUTPUT_INVALID", SAFE_MESSAGES.AI_OUTPUT_INVALID, 422);
  }
  return {
    layoutId: value.layoutId ? sanitizeText(value.layoutId, 80) : null,
    selectedProfile: value.selectedProfile ? sanitizeText(value.selectedProfile, 80) : null,
    regionId: value.regionId ? sanitizeText(value.regionId, 80) : null,
    source: value.source ? sanitizeText(value.source, 80) : null,
    finalScoreCandidate: value.finalScoreCandidate ? sanitizeText(value.finalScoreCandidate, 16) : null,
    confidence: round(clamp(value.confidence, 0, 1)),
    transitionDecision: sanitizeText(value.transitionDecision || "unreadable", 60),
    accepted: Boolean(value.accepted),
    rejectedReasonCodes: uniqueReasons(value.rejectedReasonCodes || []),
    reasonCodes: uniqueReasons(value.reasonCodes || []),
    digitBoxesFound: Math.max(0, Math.min(20, Number(value.digitBoxesFound || 0))),
    homeCandidateGroups: Math.max(0, Math.min(20, Number(value.homeCandidateGroups || 0))),
    awayCandidateGroups: Math.max(0, Math.min(20, Number(value.awayCandidateGroups || 0))),
    foregroundGroupCount: Math.max(0, Math.min(99, Number(value.foregroundGroupCount || 0))),
  };
}

module.exports = {
  buildScorebugAttemptDiagnostic,
  normalizeScore,
  parseScorebugDigitGroups,
  safeScorebugAttemptDiagnostic,
  scoreText,
  scorebugTransitionDecision,
};
