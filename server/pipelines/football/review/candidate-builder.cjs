const { createHash } = require("node:crypto");
const {
  MAX_CANDIDATES,
  assertCandidateSet,
  normalizeCandidate,
} = require("./candidate-contract.cjs");

function sourceRevisionFor(upload, projectRevision = 1) {
  const checksum = String(
    upload
    && (upload.checksumSha256
      || upload.artifact && upload.artifact.checksumSha256)
    || "",
  );
  return createHash("sha256")
    .update(
      `${checksum || "checksum-missing"}:${Math.max(
        1,
        Math.floor(Number(projectRevision || 1)),
      )}`,
    )
    .digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clampWindow(start, end, durationSeconds) {
  const safeStart = Math.max(0, Math.min(durationSeconds - 0.25, Number(start)));
  const safeEnd = Math.max(
    safeStart + 0.25,
    Math.min(durationSeconds, Number(end)),
  );
  return {
    sourceStart: Number(safeStart.toFixed(3)),
    sourceEnd: Number(safeEnd.toFixed(3)),
  };
}

function trackingConfidence(plan) {
  const crop = plan.cropPlan && typeof plan.cropPlan === "object"
    ? plan.cropPlan
    : {};
  const review = plan.reviewMetadata && typeof plan.reviewMetadata === "object"
    ? plan.reviewMetadata
    : {};
  const visual = review.visualEvidenceSummary
    && typeof review.visualEvidenceSummary === "object"
    ? review.visualEvidenceSummary
    : {};
  return Math.max(
    0,
    Math.min(
      1,
      Number(
        crop.trackingConfidence
        ?? crop.confidence
        ?? visual.actionFocusConfidence
        ?? plan.actionFocusConfidence
        ?? 0,
      ),
    ),
  );
}

function uncertaintyFor(plan, confidence) {
  const outcome = plan.goalOutcome && typeof plan.goalOutcome === "object"
    ? plan.goalOutcome.outcome
    : null;
  if (outcome === "confirmed_goal" && confidence >= 0.82) return "low";
  return confidence >= 0.65 ? "medium" : "high";
}

function captionProfile(code) {
  const profiles = {
    buildup_focused: {
      strategy: "setup_then_action",
      emphasis: "anticipation",
      maxLines: 2,
      safeArea: "lower",
    },
    finish_focused: {
      strategy: "payoff_first",
      emphasis: "finish",
      maxLines: 2,
      safeArea: "lower",
    },
    context_decision: {
      strategy: "evidence_then_decision",
      emphasis: "uncertainty",
      maxLines: 2,
      safeArea: "lower",
    },
    tracked_action: {
      strategy: "minimal_action_labels",
      emphasis: "movement",
      maxLines: 1,
      safeArea: "lower",
    },
    wide_safe: {
      strategy: "context_labels",
      emphasis: "orientation",
      maxLines: 2,
      safeArea: "lower",
    },
  };
  return profiles[code];
}

function pacingProfile(code) {
  const profiles = {
    buildup_focused: {
      rhythm: "progressive",
      hookSeconds: 1.6,
      payoffHoldSeconds: 1,
      playbackRate: 1,
    },
    finish_focused: {
      rhythm: "fast_to_hold",
      hookSeconds: 1,
      payoffHoldSeconds: 1.6,
      playbackRate: 1.03,
    },
    context_decision: {
      rhythm: "measured",
      hookSeconds: 2,
      payoffHoldSeconds: 1.8,
      playbackRate: 0.96,
    },
    tracked_action: {
      rhythm: "action_locked",
      hookSeconds: 1.2,
      payoffHoldSeconds: 1.2,
      playbackRate: 1,
    },
    wide_safe: {
      rhythm: "stable",
      hookSeconds: 1.8,
      payoffHoldSeconds: 1.5,
      playbackRate: 0.98,
    },
  };
  return profiles[code];
}

function purposeProfile(code) {
  return {
    code,
    hook: `${code}_hook`,
    payoff: `${code}_payoff`,
  };
}

function framingProfile(code, plan, confidence) {
  const existing = plan.cropPlan && typeof plan.cropPlan === "object"
    ? plan.cropPlan
    : {};
  if (code === "tracked_action") {
    return {
      status: "tracked",
      mode: "tracked_action",
      confidence,
      fallbackUsed: false,
      reasonCodes: ["high_confidence_action_tracking"],
    };
  }
  return {
    status: "safe_fallback",
    mode: "wide_safe",
    confidence,
    fallbackUsed: true,
    reasonCodes: [
      ...(Array.isArray(existing.reasonCodes) ? existing.reasonCodes : []),
      code === "context_decision"
        ? "decision_context_preserved"
        : "wide_safe_visual_context",
    ],
  };
}

function variantWindow(code, plan, durationSeconds) {
  const start = Math.max(0, Number(plan.sourceStart || 0));
  const end = Math.min(
    durationSeconds,
    Math.max(start + 0.25, Number(plan.sourceEnd || start + 8)),
  );
  const span = Math.max(0.25, end - start);
  if (code === "buildup_focused") {
    return clampWindow(start, start + span * 0.78, durationSeconds);
  }
  if (code === "finish_focused") {
    return clampWindow(start + span * 0.28, end, durationSeconds);
  }
  if (code === "context_decision") {
    return clampWindow(start - 3, end + 5, durationSeconds);
  }
  if (code === "tracked_action") {
    return clampWindow(start + span * 0.12, end - span * 0.08, durationSeconds);
  }
  return clampWindow(start - 1.5, end + 2.5, durationSeconds);
}

function buildVariant(code, plan, durationSeconds) {
  const confidence = trackingConfidence(plan);
  const window = variantWindow(code, plan, durationSeconds);
  const framing = framingProfile(code, plan, confidence);
  const captions = captionProfile(code);
  const pacing = pacingProfile(code);
  const purpose = purposeProfile(code);
  const editPlan = {
    ...clone(plan),
    sourceStart: window.sourceStart,
    sourceEnd: window.sourceEnd,
    framingMode: framing.mode,
    cropPlan: {
      ...(plan.cropPlan && typeof plan.cropPlan === "object"
        ? clone(plan.cropPlan)
        : {}),
      mode: framing.mode,
      confidence: framing.confidence,
      fallbackUsed: framing.fallbackUsed,
      reasonCodes: framing.reasonCodes,
    },
    reviewEditorial: {
      purpose,
      captions,
      pacing,
    },
  };
  return {
    ...window,
    confidence: Number(confidence.toFixed(2)),
    purpose,
    phaseWindow: {
      phase: code,
      ...window,
    },
    uncertainty: {
      level: uncertaintyFor(plan, confidence),
      requiresReview: true,
      reasonCodes: Array.isArray(plan.reasonCodes)
        ? plan.reasonCodes
        : ["insufficient_event_certainty"],
    },
    framing,
    captions,
    pacing,
    qualityWarnings: [
      ...(framing.fallbackUsed ? ["wide_safe_framing"] : []),
      ...(confidence < 0.65 ? ["low_tracking_confidence"] : []),
    ],
    editPlan,
  };
}

function selectBasePlan(input) {
  const plans = Array.isArray(input.candidatePlans)
    ? input.candidatePlans.filter((plan) => (
      plan && typeof plan === "object" && !Array.isArray(plan)
    ))
    : [];
  const fallback = input.editPlan
    && typeof input.editPlan === "object"
    && !Array.isArray(input.editPlan)
    ? input.editPlan
    : plans[0];
  if (!fallback) return null;
  return plans
    .map((plan, index) => ({
      plan,
      index,
      confidence: Number(plan.confidence || trackingConfidence(plan) || 0),
    }))
    .concat([{ plan: fallback, index: plans.length, confidence: Number(fallback.confidence || 0) }])
    .sort((left, right) => (
      right.confidence - left.confidence || left.index - right.index
    ))[0].plan;
}

function buildFootballReviewCandidates(input = {}) {
  const basePlan = selectBasePlan(input);
  if (!basePlan) return [];
  const durationSeconds = Math.max(
    1,
    Number(input.sourceDurationSeconds || basePlan.sourceEnd || 1),
  );
  const confidence = trackingConfidence(basePlan);
  const codes = [
    "buildup_focused",
    "finish_focused",
    "context_decision",
    confidence >= 0.82 ? "tracked_action" : "wide_safe",
  ];
  const candidates = codes.slice(0, MAX_CANDIDATES).map((code) => {
    const variant = buildVariant(code, basePlan, durationSeconds);
    return normalizeCandidate({
      projectId: input.projectId,
      sourceJobId: input.sourceJobId,
      sourceRevision: input.sourceRevision,
      ...variant,
    }, {
      projectId: input.projectId,
      sourceJobId: input.sourceJobId,
      sourceRevision: input.sourceRevision,
      sourceDurationSeconds: durationSeconds,
      reviewReasonCodes: input.reviewReasonCodes,
    });
  });
  return assertCandidateSet(candidates);
}

module.exports = {
  buildFootballReviewCandidates,
  buildVariant,
  sourceRevisionFor,
  trackingConfidence,
};
