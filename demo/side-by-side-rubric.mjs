import { findSensitiveLeak } from "./report-safety.mjs";

const SCORE_MIN = 0;
const SCORE_MAX = 5;
const DEFAULT_PASS_THRESHOLD = 4;

const SIDE_BY_SIDE_RUBRIC = Object.freeze([
  {
    id: "moment_selection",
    label: "Moment selection",
    description: "The generated short chooses the most engaging football action compared with the reference.",
    scoreRange: [SCORE_MIN, SCORE_MAX],
    passThreshold: DEFAULT_PASS_THRESHOLD,
    scoredBy: "human",
    weight: 1.4,
    examples: {
      "0": "Wrong or dead moment; no meaningful football action.",
      "3": "Some emotion or context, but not the strongest chance/save/foul/counter.",
      "5": "Clearly selects the highest-energy football moment.",
    },
  },
  {
    id: "caption_action_alignment",
    label: "Caption/action alignment",
    description: "On-screen text matches what is visible and what the commentator/crowd energy supports.",
    scoreRange: [SCORE_MIN, SCORE_MAX],
    passThreshold: DEFAULT_PASS_THRESHOLD,
    scoredBy: "human",
    weight: 1.3,
    examples: {
      "0": "Captions claim events that are not happening.",
      "3": "Captions are generic or loosely related.",
      "5": "Captions land exactly on the visible action beats.",
    },
  },
  {
    id: "ball_player_framing",
    label: "Ball/player framing",
    description: "The crop keeps the ball, players, goal area and decisive action visible.",
    scoreRange: [SCORE_MIN, SCORE_MAX],
    passThreshold: DEFAULT_PASS_THRESHOLD,
    scoredBy: "human",
    weight: 1.2,
    examples: {
      "0": "Crop loses the ball or the key player.",
      "3": "Action is mostly visible, but framing is unstable or cramped.",
      "5": "The key action stays readable throughout.",
    },
  },
  {
    id: "reference_style_editing",
    label: "Reference-style editing",
    description: "The result feels close to the reference style: kinetic captions, beat timing, zooms and motion energy.",
    scoreRange: [SCORE_MIN, SCORE_MAX],
    passThreshold: DEFAULT_PASS_THRESHOLD,
    scoredBy: "human",
    weight: 1,
    examples: {
      "0": "Flat edit with no recognizable reference style.",
      "3": "Some sports social style, but weak rhythm or weak animation.",
      "5": "Strong reference-style pacing and visual treatment.",
    },
  },
  {
    id: "false_goal_guard",
    label: "False-goal guard",
    description: "The result never claims goal unless the clip has explicit goal evidence.",
    scoreRange: [SCORE_MIN, SCORE_MAX],
    passThreshold: 5,
    scoredBy: "human",
    weight: 1.4,
    examples: {
      "0": "Claims a goal when there is no explicit goal evidence.",
      "3": "Avoids direct goal claim but uses misleading finish language.",
      "5": "No false goal claim or misleading goal implication.",
    },
  },
  {
    id: "hook_strength",
    label: "Hook strength",
    description: "The first second creates curiosity or impact without lying about the moment.",
    scoreRange: [SCORE_MIN, SCORE_MAX],
    passThreshold: DEFAULT_PASS_THRESHOLD,
    scoredBy: "human",
    weight: 0.8,
    examples: {
      "0": "No hook, or the hook is misleading.",
      "3": "Understandable but not very sticky.",
      "5": "Immediate scroll-stopping context.",
    },
  },
  {
    id: "pacing_energy",
    label: "Pacing and energy",
    description: "The edit rhythm matches the excitement of the football moment.",
    scoreRange: [SCORE_MIN, SCORE_MAX],
    passThreshold: DEFAULT_PASS_THRESHOLD,
    scoredBy: "human",
    weight: 0.8,
    examples: {
      "0": "Slow, flat or disconnected from the action.",
      "3": "Acceptable but not especially dynamic.",
      "5": "Tight rhythm with strong beat/action timing.",
    },
  },
  {
    id: "text_readability",
    label: "Text readability",
    description: "Captions are readable, timed well, and do not hide the key action.",
    scoreRange: [SCORE_MIN, SCORE_MAX],
    passThreshold: DEFAULT_PASS_THRESHOLD,
    scoredBy: "human",
    weight: 0.6,
    examples: {
      "0": "Text is unreadable or blocks the action.",
      "3": "Readable but too generic, too large or not timed well.",
      "5": "Clear, polished and well-positioned.",
    },
  },
  {
    id: "replay_or_context_use",
    label: "Replay/context use",
    description: "Replay, crowd, coach or commentator context is used only when it helps the story.",
    scoreRange: [SCORE_MIN, SCORE_MAX],
    passThreshold: DEFAULT_PASS_THRESHOLD,
    scoredBy: "human",
    weight: 0.5,
    examples: {
      "0": "Uses irrelevant context instead of the moment.",
      "3": "Context is understandable but not necessary.",
      "5": "Context sharpens the story and timing.",
    },
  },
  {
    id: "overall_short_quality",
    label: "Overall short quality",
    description: "The generated output is good enough to use as a product review sample.",
    scoreRange: [SCORE_MIN, SCORE_MAX],
    passThreshold: DEFAULT_PASS_THRESHOLD,
    scoredBy: "human",
    weight: 1,
    examples: {
      "0": "Not usable as a short.",
      "3": "Useful signal, but needs product/AI fixes.",
      "5": "Ready as a strong product-quality short.",
    },
  },
]);

const REVIEW_FLAGS = Object.freeze([
  "falseGoalClaim",
  "badCrop",
  "captionMismatch",
  "lowEnergy",
  "wrongMoment",
  "missingTrendEditing",
]);

const FLAG_TO_CRITERION = Object.freeze({
  falseGoalClaim: "false_goal_guard",
  badCrop: "ball_player_framing",
  captionMismatch: "caption_action_alignment",
  lowEnergy: "pacing_energy",
  wrongMoment: "moment_selection",
  missingTrendEditing: "reference_style_editing",
});

const FLAG_PENALTIES = Object.freeze({
  falseGoalClaim: 35,
  badCrop: 20,
  captionMismatch: 18,
  lowEnergy: 8,
  wrongMoment: 25,
  missingTrendEditing: 10,
});

const CRITICAL_FLAGS = Object.freeze(["falseGoalClaim", "badCrop", "captionMismatch", "wrongMoment"]);
const CRITICAL_CRITERIA = Object.freeze(["moment_selection", "caption_action_alignment", "ball_player_framing", "false_goal_guard"]);

const IMPROVEMENT_HINTS = Object.freeze({
  moment_selection: {
    id: "improve_highlight_ranking",
    target: "analysis.highlight_ranking",
    note: "Improve audio-visual excitement cues for chances, saves, fouls, counters, replays and crowd reactions.",
  },
  caption_action_alignment: {
    id: "improve_caption_action_planner",
    target: "edit_plan.caption_action_alignment",
    note: "Generate captions from the selected visible action instead of generic hype text.",
  },
  ball_player_framing: {
    id: "improve_crop_framing",
    target: "render.crop_framing_strategy",
    note: "Prefer wide-safe framing until ball/player tracking is confident.",
  },
  reference_style_editing: {
    id: "improve_reference_style_renderer",
    target: "render.kinetic_caption_style",
    note: "Add stronger reference-style motion, caption emphasis and beat-synced animation cues.",
  },
  false_goal_guard: {
    id: "strengthen_false_goal_guard",
    target: "analysis.false_goal_guard",
    note: "Never use goal language without explicit goal evidence.",
  },
  hook_strength: {
    id: "improve_opening_hook",
    target: "edit_plan.opening_hook",
    note: "Make the first caption specific to the visible football moment.",
  },
  pacing_energy: {
    id: "improve_pacing_energy",
    target: "edit_plan.pacing_animation_cues",
    note: "Increase cut/caption energy only when the action or crowd/commentary supports it.",
  },
  text_readability: {
    id: "improve_caption_readability",
    target: "render.caption_readability",
    note: "Keep captions readable without blocking the ball or key players.",
  },
  replay_or_context_use: {
    id: "improve_context_classifier",
    target: "analysis.replay_context_classifier",
    note: "Use replay/crowd/coach context only when it adds story value.",
  },
  overall_short_quality: {
    id: "improve_quality_loop",
    target: "product.quality_loop",
    note: "Use operator review failures to prioritize the next AI/product fixes.",
  },
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeText(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function criterionIds() {
  return SIDE_BY_SIDE_RUBRIC.map((criterion) => criterion.id);
}

function criterionById(id) {
  return SIDE_BY_SIDE_RUBRIC.find((criterion) => criterion.id === id) || null;
}

function safeFailure(code, message, field) {
  return {
    code,
    message,
    ...(field ? { field: sanitizeText(field, 120) } : {}),
  };
}

function normalizeReviewRelativePath(value, field) {
  const text = String(value ?? "").trim().replace(/\\/g, "/");
  if (
    !text ||
    text.startsWith("/") ||
    /^[A-Za-z]:\//.test(text) ||
    text.includes("\0") ||
    text.split("/").some((part) => part === "..")
  ) {
    return {
      ok: false,
      failure: safeFailure("SIDE_BY_SIDE_REVIEW_RELATIVE_REF_UNSAFE", "Review video references must be safe relative paths.", field),
    };
  }
  const leak = findSensitiveLeak(text);
  if (leak) {
    return {
      ok: false,
      failure: safeFailure("SIDE_BY_SIDE_REVIEW_LEAK_GUARD", "Review video references must not contain sensitive data.", field),
    };
  }
  return { ok: true, relativePath: sanitizeText(text, 240) };
}

function scoreValue(entry) {
  if (typeof entry === "number") return { score: entry, notes: "" };
  if (!entry || typeof entry !== "object") return null;
  return {
    score: entry.score,
    notes: entry.notes,
  };
}

function validateRubricSchema(rubric = SIDE_BY_SIDE_RUBRIC) {
  const failures = [];
  const seen = new Set();
  for (const criterion of rubric) {
    if (!criterion || typeof criterion !== "object") {
      failures.push(safeFailure("RUBRIC_CRITERION_INVALID", "Rubric criterion must be an object."));
      continue;
    }
    if (!/^[a-z][a-z0-9_]{2,80}$/.test(String(criterion.id || ""))) {
      failures.push(safeFailure("RUBRIC_CRITERION_ID_INVALID", "Rubric criterion id is invalid.", "id"));
    }
    if (seen.has(criterion.id)) {
      failures.push(safeFailure("RUBRIC_CRITERION_DUPLICATE", "Rubric criterion ids must be unique.", criterion.id));
    }
    seen.add(criterion.id);
    if (!Number.isFinite(Number(criterion.weight)) || Number(criterion.weight) <= 0) {
      failures.push(safeFailure("RUBRIC_WEIGHT_INVALID", "Rubric criterion weight must be positive.", criterion.id));
    }
    if (!Array.isArray(criterion.scoreRange) || criterion.scoreRange[0] !== SCORE_MIN || criterion.scoreRange[1] !== SCORE_MAX) {
      failures.push(safeFailure("RUBRIC_SCORE_RANGE_INVALID", "Rubric score range must be 0-5.", criterion.id));
    }
    const threshold = Number(criterion.passThreshold);
    if (!Number.isFinite(threshold) || threshold < SCORE_MIN || threshold > SCORE_MAX) {
      failures.push(safeFailure("RUBRIC_THRESHOLD_INVALID", "Rubric pass threshold must fit the score range.", criterion.id));
    }
    if (criterion.scoredBy !== "human" && criterion.scoredBy !== "machine") {
      failures.push(safeFailure("RUBRIC_SCORER_INVALID", "Rubric criterion needs an explicit scorer.", criterion.id));
    }
  }
  return { ok: failures.length === 0, failures };
}

function validateManualReview(payload, context = {}) {
  const failures = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      review: null,
      failedCases: [safeFailure("SIDE_BY_SIDE_REVIEW_INVALID", "Manual review must be a JSON object.")],
    };
  }

  const payloadLeak = findSensitiveLeak(payload);
  if (payloadLeak) {
    failures.push({
      ...safeFailure("SIDE_BY_SIDE_REVIEW_LEAK_GUARD", "Manual review contains unsafe data."),
      leakCode: payloadLeak.code,
      leakPath: payloadLeak.path,
    });
  }

  if (payload.schemaVersion !== undefined && Number(payload.schemaVersion) !== 1) {
    failures.push(safeFailure("SIDE_BY_SIDE_REVIEW_SCHEMA_UNSUPPORTED", "Manual review schemaVersion must be 1.", "schemaVersion"));
  }

  const generatedRef = normalizeReviewRelativePath(
    payload.generatedRelativePath || payload.generated?.relativePath,
    "generatedRelativePath"
  );
  const referenceRef = normalizeReviewRelativePath(
    payload.referenceRelativePath || payload.reference?.relativePath,
    "referenceRelativePath"
  );
  if (!generatedRef.ok) failures.push(generatedRef.failure);
  if (!referenceRef.ok) failures.push(referenceRef.failure);
  if (generatedRef.ok && context.expectedGeneratedRelativePath && generatedRef.relativePath !== context.expectedGeneratedRelativePath) {
    failures.push(safeFailure("SIDE_BY_SIDE_REVIEW_GENERATED_MISMATCH", "Manual review generated reference does not match this comparison.", "generatedRelativePath"));
  }
  if (referenceRef.ok && context.expectedReferenceRelativePath && referenceRef.relativePath !== context.expectedReferenceRelativePath) {
    failures.push(safeFailure("SIDE_BY_SIDE_REVIEW_REFERENCE_MISMATCH", "Manual review reference video does not match this comparison.", "referenceRelativePath"));
  }

  const reviewer = sanitizeText(payload.reviewer || "operator", 80);
  if (!reviewer) failures.push(safeFailure("SIDE_BY_SIDE_REVIEW_REVIEWER_INVALID", "Manual review needs a reviewer.", "reviewer"));
  const reviewedAt = sanitizeText(payload.reviewedAt || "", 40);
  if (!reviewedAt || Number.isNaN(Date.parse(reviewedAt))) {
    failures.push(safeFailure("SIDE_BY_SIDE_REVIEW_DATE_INVALID", "Manual review needs a valid reviewedAt timestamp.", "reviewedAt"));
  }

  const criteriaInput = payload.criteria;
  if (!criteriaInput || typeof criteriaInput !== "object" || Array.isArray(criteriaInput)) {
    failures.push(safeFailure("SIDE_BY_SIDE_REVIEW_CRITERIA_INVALID", "Manual review needs criterion scores.", "criteria"));
  }

  const rubricIds = criterionIds();
  const normalizedCriteria = [];
  if (criteriaInput && typeof criteriaInput === "object" && !Array.isArray(criteriaInput)) {
    for (const id of Object.keys(criteriaInput)) {
      if (!rubricIds.includes(id)) {
        failures.push(safeFailure("SIDE_BY_SIDE_REVIEW_UNKNOWN_CRITERION", "Manual review contains an unknown criterion.", `criteria.${id}`));
      }
    }
    for (const id of rubricIds) {
      const criterion = criterionById(id);
      if (!(id in criteriaInput)) {
        failures.push(safeFailure("SIDE_BY_SIDE_REVIEW_CRITERION_MISSING", "Manual review is missing a required criterion.", `criteria.${id}`));
        continue;
      }
      const entry = scoreValue(criteriaInput[id]);
      if (!entry) {
        failures.push(safeFailure("SIDE_BY_SIDE_REVIEW_CRITERION_INVALID", "Criterion score must be a number or an object.", `criteria.${id}`));
        continue;
      }
      const score = Number(entry.score);
      if (!Number.isFinite(score) || score < SCORE_MIN || score > SCORE_MAX) {
        failures.push(safeFailure("SIDE_BY_SIDE_REVIEW_SCORE_INVALID", "Criterion score must be between 0 and 5.", `criteria.${id}.score`));
        continue;
      }
      const rawNotes = String(entry.notes ?? "");
      if (rawNotes.length > 500) {
        failures.push(safeFailure("SIDE_BY_SIDE_REVIEW_NOTE_TOO_LONG", "Criterion notes must be 500 characters or less.", `criteria.${id}.notes`));
      }
      const notes = sanitizeText(rawNotes, 500);
      const noteLeak = findSensitiveLeak(notes);
      if (noteLeak) {
        failures.push({
          ...safeFailure("SIDE_BY_SIDE_REVIEW_LEAK_GUARD", "Criterion notes contain unsafe data.", `criteria.${id}.notes`),
          leakCode: noteLeak.code,
          leakPath: noteLeak.path,
        });
      }
      normalizedCriteria.push({
        id,
        label: criterion.label,
        score: Number(score.toFixed(2)),
        passThreshold: criterion.passThreshold,
        weight: criterion.weight,
        notes,
      });
    }
  }

  const flagsInput = payload.flags || {};
  if (typeof flagsInput !== "object" || Array.isArray(flagsInput)) {
    failures.push(safeFailure("SIDE_BY_SIDE_REVIEW_FLAGS_INVALID", "Manual review flags must be an object.", "flags"));
  }
  const flags = {};
  for (const flag of REVIEW_FLAGS) flags[flag] = Boolean(flagsInput[flag]);
  if (flagsInput && typeof flagsInput === "object" && !Array.isArray(flagsInput)) {
    for (const flag of Object.keys(flagsInput)) {
      if (!REVIEW_FLAGS.includes(flag)) {
        failures.push(safeFailure("SIDE_BY_SIDE_REVIEW_UNKNOWN_FLAG", "Manual review contains an unknown flag.", `flags.${flag}`));
      }
    }
  }

  const rawNotes = String(payload.notes ?? "");
  if (rawNotes.length > 1000) {
    failures.push(safeFailure("SIDE_BY_SIDE_REVIEW_NOTES_TOO_LONG", "Manual review notes must be 1000 characters or less.", "notes"));
  }
  const notes = sanitizeText(rawNotes, 1000);
  const notesLeak = findSensitiveLeak(notes);
  if (notesLeak) {
    failures.push({
      ...safeFailure("SIDE_BY_SIDE_REVIEW_LEAK_GUARD", "Manual review notes contain unsafe data.", "notes"),
      leakCode: notesLeak.code,
      leakPath: notesLeak.path,
    });
  }

  if (failures.length > 0) {
    return { ok: false, review: null, failedCases: failures };
  }

  const review = {
    schemaVersion: 1,
    reviewer,
    reviewedAt,
    videoRefs: {
      generated: { relativePath: generatedRef.relativePath },
      reference: { relativePath: referenceRef.relativePath },
    },
    criteria: normalizedCriteria,
    flags,
    notes,
  };
  const normalizedLeak = findSensitiveLeak(review);
  if (normalizedLeak) {
    return {
      ok: false,
      review: null,
      failedCases: [{
        ...safeFailure("SIDE_BY_SIDE_REVIEW_LEAK_GUARD", "Normalized manual review contains unsafe data."),
        leakCode: normalizedLeak.code,
        leakPath: normalizedLeak.path,
      }],
    };
  }

  return { ok: true, review, failedCases: [] };
}

function statusForCriterion(entry, flags) {
  const forcedFailureFlag = Object.entries(FLAG_TO_CRITERION).find(([flag, criterionId]) => flags[flag] && criterionId === entry.id);
  if (forcedFailureFlag) return "failed";
  if (entry.score >= entry.passThreshold) return "passed";
  if (entry.score >= Math.max(SCORE_MIN, entry.passThreshold - 1)) return "borderline";
  return "failed";
}

function uniqueHints(entries) {
  const seen = new Set();
  const hints = [];
  for (const entry of entries) {
    const hint = IMPROVEMENT_HINTS[entry];
    if (!hint || seen.has(hint.id)) continue;
    seen.add(hint.id);
    hints.push(hint);
  }
  return hints;
}

function scoreManualReview(review, structuralScore = null) {
  const criteria = review.criteria.map((entry) => ({
    ...entry,
    status: statusForCriterion(entry, review.flags),
  }));
  const totalWeight = criteria.reduce((sum, entry) => sum + entry.weight, 0);
  const weightedScore = criteria.reduce((sum, entry) => sum + (entry.score / SCORE_MAX) * entry.weight, 0);
  const baseHumanScore = Math.round((weightedScore / totalWeight) * 100);
  const activePenalties = Object.entries(review.flags)
    .filter(([flag, enabled]) => enabled && FLAG_PENALTIES[flag])
    .map(([flag]) => ({
      flag,
      criterion: FLAG_TO_CRITERION[flag],
      points: FLAG_PENALTIES[flag],
    }));
  const penaltyPoints = activePenalties.reduce((sum, penalty) => sum + penalty.points, 0);
  const humanScore = Math.max(0, baseHumanScore - penaltyPoints);
  let combinedScore = Number.isFinite(structuralScore)
    ? Math.round(structuralScore * 0.25 + humanScore * 0.75)
    : humanScore;
  if (review.flags.falseGoalClaim) combinedScore = Math.min(combinedScore, 35);
  if (review.flags.wrongMoment) combinedScore = Math.min(combinedScore, 55);
  if (review.flags.badCrop) combinedScore = Math.min(combinedScore, 65);
  if (review.flags.captionMismatch) combinedScore = Math.min(combinedScore, 70);

  const failedCriteria = criteria.filter((entry) => entry.status === "failed");
  const borderlineCriteria = criteria.filter((entry) => entry.status === "borderline");
  const criticalFlagActive = CRITICAL_FLAGS.some((flag) => review.flags[flag]);
  const criticalCriterionFailed = failedCriteria.some((entry) => CRITICAL_CRITERIA.includes(entry.id));
  const productReady = combinedScore >= 78 && !criticalFlagActive && !criticalCriterionFailed;
  const captionQualityPassed = !review.flags.captionMismatch && !failedCriteria.some((entry) => entry.id === "caption_action_alignment");
  const hintIds = [
    ...failedCriteria.map((entry) => entry.id),
    ...borderlineCriteria.map((entry) => entry.id),
    ...activePenalties.map((penalty) => penalty.criterion),
  ];

  return {
    humanScoreBase: baseHumanScore,
    humanScore,
    combinedScore,
    qualityStatus: productReady ? "product_ready" : "needs_improvement",
    productReady,
    captionQualityPassed,
    failedCriteria: failedCriteria.map((entry) => ({ id: entry.id, score: entry.score, status: entry.status })),
    borderlineCriteria: borderlineCriteria.map((entry) => ({ id: entry.id, score: entry.score, status: entry.status })),
    penalties: activePenalties,
    criterionBreakdown: criteria,
    improvementHints: uniqueHints(hintIds),
  };
}

function pendingHumanReviewSummary(metrics) {
  return {
    structuralScore: Number(metrics?.machineScore ?? 0),
    humanReviewRequired: true,
    manualReviewPresent: false,
    humanScore: null,
    combinedScore: null,
    qualityStatus: "pending_human_review",
    productReady: false,
    captionQualityPassed: null,
    pendingCriteria: SIDE_BY_SIDE_RUBRIC.map((criterion) => ({
      id: criterion.id,
      label: criterion.label,
      scoreRange: criterion.scoreRange,
      passThreshold: criterion.passThreshold,
      weight: criterion.weight,
      scoredBy: criterion.scoredBy,
    })),
    failedCriteria: [],
    borderlineCriteria: [],
    penalties: [],
    improvementHints: [
      {
        id: "complete_operator_review",
        target: "demo.side_by_side_review",
        note: "Run npm run demo:compare with -- --review=<review-json> to score creative quality.",
      },
    ],
  };
}

function buildQualitySummary(metrics, manualReview = { present: false }) {
  if (!manualReview.present || !manualReview.ok || !manualReview.review) {
    return pendingHumanReviewSummary(metrics);
  }
  const scored = scoreManualReview(manualReview.review, Number(metrics?.machineScore ?? 0));
  return {
    structuralScore: Number(metrics?.machineScore ?? 0),
    humanReviewRequired: false,
    manualReviewPresent: true,
    humanScore: scored.humanScore,
    humanScoreBase: scored.humanScoreBase,
    combinedScore: scored.combinedScore,
    qualityStatus: scored.qualityStatus,
    productReady: scored.productReady,
    captionQualityPassed: scored.captionQualityPassed,
    failedCriteria: scored.failedCriteria,
    borderlineCriteria: scored.borderlineCriteria,
    penalties: scored.penalties,
    criterionBreakdown: scored.criterionBreakdown,
    improvementHints: scored.improvementHints,
  };
}

export {
  REVIEW_FLAGS,
  SIDE_BY_SIDE_RUBRIC,
  buildQualitySummary,
  criterionIds,
  scoreManualReview,
  validateManualReview,
  validateRubricSchema,
};
