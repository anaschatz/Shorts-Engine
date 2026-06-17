const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRegenerationPlan,
  validateRegenerationPlan,
} = require("../server/regeneration-plan.cjs");
const { findReviewSensitiveLeak } = require("../eval/review-comparison.cjs");

const METADATA = Object.freeze({ durationSeconds: 20, width: 1920, height: 1080 });

function suggestion(overrides = {}) {
  return {
    id: "sug_caption_action_alignment",
    type: "caption_rewrite",
    severity: "warning",
    target: "caption",
    message: "Captions do not line up with the visible action.",
    reasonCode: "CAPTION_ACTION_MISMATCH",
    safeAction: "Rewrite captions around the actual action.",
    canAutoApply: false,
    requiresHumanReview: true,
    relatedMetric: "captionActionAlignment",
    relatedFailureCode: "REVIEW_METRIC_FAILED",
    ...overrides,
  };
}

function editPlan(overrides = {}) {
  return {
    sourceStart: 4,
    sourceEnd: 12,
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceDurationSeconds: 20,
    aspectRatio: "9:16",
    highlightType: "big_chance",
    reasonCodes: ["big_chance", "audio_energy_spike"],
    hook: "THE CHANCE OPENS",
    framingMode: "safe_center",
    cropStrategy: {
      type: "center_crop",
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      zoom: 1.02,
      preserveFullFrame: false,
      maxCropPercent: 0.2,
    },
    stylePreset: "social_sports_v1",
    captions: [
      { start: 0, end: 1.1, role: "opening_hook", text: "THE CHANCE OPENS" },
      { start: 1.2, end: 3.2, role: "context", text: "Pressure builds fast" },
      { start: 3.3, end: 5.8, role: "action_callout", text: "Almost punished in one touch" },
      { start: 5.9, end: 7.8, role: "closing_punch", text: "Replay the timing" },
    ],
    animationCues: [
      { type: "intro_hook", start: 0, end: 1 },
      { type: "kinetic_caption", start: 1, end: 3 },
    ],
    export: { width: 1080, height: 1920, format: "mp4" },
    ...overrides,
  };
}

test("regeneration builder returns not-needed state for clean reviews", () => {
  const plan = buildRegenerationPlan({
    originalEditPlan: editPlan(),
    reviewSuggestions: [],
    sourceMetadata: METADATA,
  });

  assert.equal(plan.status, "not_needed");
  assert.equal(plan.proposedEditPlan, null);
  assert.equal(plan.canRender, false);
  assert.equal(plan.requiresHumanApproval, true);
  assert.equal(plan.safetyChecks.some((check) => check.code === "NO_REGENERATION_NEEDED"), true);
});

test("false goal guard removes unsupported goal language from proposed plan", () => {
  const plan = buildRegenerationPlan({
    originalEditPlan: editPlan({
      captions: [
        { start: 0, end: 1, role: "opening_hook", text: "GOAL FROM NOWHERE" },
        { start: 1.1, end: 2.4, role: "context", text: "Pressure builds fast" },
      ],
    }),
    reviewSuggestions: [suggestion({
      id: "sug_false_goal_guard",
      type: "false_goal_guard",
      severity: "blocking",
      target: "review",
      message: "Goal language appears without explicit goal evidence.",
      reasonCode: "FALSE_GOAL_RISK",
      safeAction: "Remove unsupported goal wording.",
      relatedMetric: "noFalseGoalClaim",
    })],
    sourceMetadata: METADATA,
  });

  const text = JSON.stringify(plan.proposedEditPlan.captions.map((caption) => caption.text));
  assert.doesNotMatch(text, /goal/i);
  assert.equal(plan.appliedSuggestionIds.includes("sug_false_goal_guard"), true);
  assert.equal(plan.canRender, false);
  assert.equal(plan.safetyChecks.find((check) => check.code === "NO_FALSE_GOAL_CLAIM").status, "passed");
  assert.equal(findReviewSensitiveLeak(plan), null);
});

test("timing, framing, aspect and animation suggestions produce validated conservative draft", () => {
  const plan = buildRegenerationPlan({
    originalEditPlan: editPlan({
      aspectRatio: "1:1",
      export: { width: 1080, height: 1080, format: "mp4" },
    }),
    reviewSuggestions: [
      suggestion({
        id: "sug_caption_timing",
        type: "caption_timing_adjustment",
        target: "editPlan",
        reasonCode: "PACING_OUT_OF_RANGE",
        safeAction: "Bound caption timing.",
      }),
      suggestion({
        id: "sug_framing_adjustment",
        type: "framing_adjustment",
        severity: "blocking",
        target: "framing",
        reasonCode: "FRAMING_SAFETY_FAILED",
        safeAction: "Use wide-safe framing.",
      }),
      suggestion({
        id: "sug_aspect_ratio_fix",
        type: "aspect_ratio_fix",
        severity: "blocking",
        target: "editPlan",
        reasonCode: "ASPECT_RATIO_MISMATCH",
        safeAction: "Use vertical short export.",
      }),
      suggestion({
        id: "sug_animation_cues",
        type: "animation_cue_adjustment",
        target: "animation",
        reasonCode: "ANIMATION_CUE_GAP",
        safeAction: "Use allowed animation cues.",
      }),
    ],
    sourceMetadata: METADATA,
  });

  assert.equal(plan.proposedEditPlan.aspectRatio, "9:16");
  assert.deepEqual(plan.proposedEditPlan.export, { width: 1080, height: 1920, format: "mp4" });
  assert.equal(plan.proposedEditPlan.framingMode, "wide_safe_vertical");
  assert.equal(plan.proposedEditPlan.cropStrategy.preserveFullFrame, true);
  assert.equal(plan.proposedEditPlan.cropStrategy.maxCropPercent, 0);
  assert.ok(plan.proposedEditPlan.animationCues.length > 0);
  plan.proposedEditPlan.captions.forEach((caption) => {
    assert.ok(caption.start >= 0);
    assert.ok(caption.end > caption.start);
    assert.ok(caption.end <= 8);
  });
  validateRegenerationPlan(plan, METADATA);
});

test("moment reselection stays manual and does not auto-pick a different moment", () => {
  const original = editPlan();
  const plan = buildRegenerationPlan({
    originalEditPlan: original,
    reviewSuggestions: [suggestion({
      id: "sug_moment_reselection",
      type: "moment_reselection",
      severity: "blocking",
      target: "moment",
      reasonCode: "MOMENT_TYPE_MISMATCH",
      safeAction: "Choose a better moment after manual review.",
    })],
    sourceMetadata: METADATA,
  });

  assert.equal(plan.proposedEditPlan.sourceStart, original.sourceStart);
  assert.equal(plan.proposedEditPlan.sourceEnd, original.sourceEnd);
  assert.equal(plan.skippedSuggestionIds.includes("sug_moment_reselection"), true);
  assert.equal(plan.blockingReasons.some((reason) => reason.code === "MOMENT_RESELECTION_REQUIRES_HUMAN_REVIEW"), true);
  assert.equal(plan.canRender, false);
});

test("regeneration builder rejects invalid suggestions and invalid edit plans safely", () => {
  assert.throws(
    () => buildRegenerationPlan({
      originalEditPlan: editPlan(),
      reviewSuggestions: [suggestion({ type: "unsafe_type" })],
      sourceMetadata: METADATA,
    }),
    /type/,
  );

  assert.throws(
    () => buildRegenerationPlan({
      originalEditPlan: { sourceStart: 0, sourceEnd: 2, captions: [] },
      reviewSuggestions: [suggestion()],
      sourceMetadata: METADATA,
    }),
    /Edit plan|Export settings|captions|aspect ratio|Unsupported highlight type/i,
  );
});
