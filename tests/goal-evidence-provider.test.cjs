const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeGoalEvidence,
  deterministicGoalEvidence,
  mergeGoalEvidenceIntoVisualSignals,
  publicGoalEvidence,
  validateGoalEvidenceOutput,
} = require("../server/goal-evidence-provider.cjs");
const { visualReasonCodesForWindow } = require("../server/vision.cjs");

const metadata = { durationSeconds: 80, width: 1920, height: 1080 };

test("goal evidence provider confirms ball-in-net only with explicit decision evidence", () => {
  const goalEvidence = deterministicGoalEvidence({
    metadata,
    transcript: {
      captions: [{ start: 34.4, end: 35.6, text: "Goal confirmed, the finish counts" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 24, end: 25.5, types: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.9 },
        { start: 27, end: 28.5, types: ["goal_mouth_visible", "ball_in_net"], confidence: 0.91 },
      ],
    },
  });

  assert.equal(goalEvidence.summary.validGoalCount, 1);
  assert.equal(goalEvidence.events[0].outcomeHint, "valid_goal");
  assert.equal(goalEvidence.events[0].ballInNetEvidence, true);
  assert.equal(goalEvidence.events[0].commentatorGoalCall, true);
  assert.ok(goalEvidence.events[0].reasonCodes.includes("confirmed_by_commentary"));
  assert.doesNotMatch(JSON.stringify(publicGoalEvidence(goalEvidence)), /\/Users|storageKey|localPath|token|secret/i);
});

test("goal evidence provider marks post-goal offside/no-goal context without creating valid goal", () => {
  const goalEvidence = deterministicGoalEvidence({
    metadata,
    transcript: {
      captions: [{ start: 39, end: 40.2, text: "The flag is up, no goal for offside" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 28, end: 29.4, types: ["shot_contact", "ball_toward_goal"], confidence: 0.88 },
        { start: 31, end: 32.5, types: ["ball_in_net"], confidence: 0.9 },
        { start: 39, end: 40.2, types: ["assistant_referee_flag", "referee_no_goal_signal"], confidence: 0.86 },
      ],
    },
  });

  assert.equal(goalEvidence.summary.validGoalCount, 0);
  assert.equal(goalEvidence.summary.offsideOrNoGoalCount, 1);
  assert.equal(goalEvidence.events[0].outcomeHint, "offside_goal");
  assert.equal(goalEvidence.events[0].offsideFlag, true);
  assert.equal(goalEvidence.events[0].VARNoGoalSignal, true);
});

test("goal evidence provider does not promote crowd/commentary support without ball-in-net", () => {
  const goalEvidence = deterministicGoalEvidence({
    metadata,
    transcript: {
      captions: [{ start: 12, end: 13.4, text: "The crowd explodes after that chance" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 10, end: 12, types: ["shot_like_motion", "goal_area_visible", "crowd_reaction"], confidence: 0.9 },
      ],
    },
  });

  assert.equal(goalEvidence.summary.validGoalCount, 0);
  assert.equal(goalEvidence.events[0].outcomeHint, "non_goal_chance");
  assert.equal(goalEvidence.events[0].ballInNetEvidence, false);
  assert.equal(goalEvidence.events[0].commentatorGoalCall, false);
});

test("goal evidence supplemental windows are safe and merge back into visual signals", () => {
  const goalEvidence = deterministicGoalEvidence({
    metadata,
    transcript: {
      captions: [{ start: 44, end: 45, text: "Goal confirmed, it counts" }],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        { start: 34, end: 36, types: ["ball_in_net"], confidence: 0.9 },
        { start: 44, end: 45, types: ["scoreboard_goal_confirmed"], confidence: 0.86 },
      ],
    },
  });
  const visualSignals = mergeGoalEvidenceIntoVisualSignals({
    providerMode: "fixture-visual",
    fallbackUsed: false,
    windows: [
      { start: 34, end: 36, types: ["ball_in_net"], confidence: 0.9 },
      { start: 44, end: 45, types: ["scoreboard_goal_confirmed"], confidence: 0.86 },
    ],
  }, goalEvidence, metadata);

  const reasons = visualSignals.windows.flatMap(visualReasonCodesForWindow);
  assert.ok(reasons.includes("visual_ball_in_net"));
  assert.ok(reasons.includes("visual_scoreboard_goal_confirmed"));
  assert.doesNotMatch(JSON.stringify(visualSignals), /\/Users|storageKey|localPath|token|secret/i);
});

test("goal evidence contract rejects unsafe provider output", () => {
  assert.throws(
    () => validateGoalEvidenceOutput({
      providerMode: "external-goal-evidence-adapter",
      fallbackUsed: false,
      events: [{
        id: "bad",
        start: 1,
        end: 2,
        outcomeHint: "valid_goal",
        confidence: 0.9,
        evidenceSource: "/Users/example/private",
        reasonCodes: ["ball_in_net", "visual_scoreboard_goal_confirmed"],
      }],
    }, metadata),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );
});

test("goal evidence provider cancellation is fail-closed", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    analyzeGoalEvidence({
      mode: "external",
      metadata,
      signal: controller.signal,
      client: {
        analyzeGoalEvidence: () => new Promise(() => {}),
      },
    }),
    (error) => error.code === "JOB_CANCELLED",
  );
});
