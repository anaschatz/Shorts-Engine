const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeSemanticGoalFrames,
  classifyFeatures,
} = require("../server/semantic-goal-visibility.cjs");

test("semantic goal visibility classifies goalmouth finish features as clear", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.26,
    whiteRatio: 0.034,
    darkRatio: 0.18,
    skinRatio: 0.012,
    saturatedColorRatio: 0.16,
    blackBarRatio: 0,
  }, "finish");

  assert.equal(evidence.visibilityVerdict, "clear");
  assert.equal(evidence.hasVisibleFinish, true);
  assert.equal(evidence.hasBallInNetOrPayoff, true);
  assert.equal(evidence.hasGoalMouth, true);
});

test("semantic goal visibility accepts low-white goalmouth finish with clear field action", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.3612,
    whiteRatio: 0.0164,
    darkRatio: 0.0591,
    skinRatio: 0.0046,
    saturatedColorRatio: 0.1522,
    blackBarRatio: 0.001,
  }, "finish");

  assert.equal(evidence.visibilityVerdict, "clear");
  assert.equal(evidence.hasVisibleFinish, true);
  assert.equal(evidence.hasBallInNetOrPayoff, true);
  assert.equal(evidence.hasGoalMouth, true);
});

test("semantic goal visibility rejects player closeup frames", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.04,
    whiteRatio: 0.01,
    darkRatio: 0.16,
    skinRatio: 0.08,
    saturatedColorRatio: 0.2,
    blackBarRatio: 0,
  }, "finish");

  assert.equal(evidence.visibilityVerdict, "failed");
  assert.equal(evidence.playerCloseupOnly, true);
  assert.ok(evidence.reasons.includes("semantic_player_closeup_only"));
});

test("semantic goal visibility rejects finish frames dominated by player celebration closeups", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.3366,
    whiteRatio: 0.1797,
    darkRatio: 0.0206,
    skinRatio: 0.0366,
    saturatedColorRatio: 0.0446,
    blackBarRatio: 0.0021,
  }, "finish");

  assert.equal(evidence.visibilityVerdict, "failed");
  assert.equal(evidence.playerCloseupOnly, true);
  assert.ok(evidence.reasons.includes("semantic_player_closeup_only"));
});

test("semantic goal visibility rejects tight saturated payoff closeups", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.564,
    whiteRatio: 0.0455,
    darkRatio: 0.0293,
    skinRatio: 0.0843,
    saturatedColorRatio: 0.3451,
    blackBarRatio: 0.0001,
  }, "payoff");

  assert.equal(evidence.visibilityVerdict, "failed");
  assert.equal(evidence.playerCloseupOnly, true);
});

test("semantic goal visibility rejects broadcast celebration finish frames", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.3829,
    whiteRatio: 0.0922,
    darkRatio: 0.0523,
    skinRatio: 0.0285,
    saturatedColorRatio: 0.0257,
    blackBarRatio: 0.005,
  }, "finish");

  assert.equal(evidence.visibilityVerdict, "failed");
  assert.equal(evidence.playerCloseupOnly, true);
  assert.ok(evidence.reasons.includes("semantic_player_closeup_only"));
});

test("semantic goal visibility rejects green-heavy celebration payoff clusters", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.6731,
    whiteRatio: 0.0399,
    darkRatio: 0.0722,
    skinRatio: 0.0229,
    saturatedColorRatio: 0.0479,
    blackBarRatio: 0.0002,
  }, "payoff");

  assert.equal(evidence.visibilityVerdict, "failed");
  assert.equal(evidence.playerCloseupOnly, true);
  assert.ok(evidence.reasons.includes("semantic_player_closeup_only"));
});

test("semantic goal visibility rejects back-of-player payoff frames", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.6507,
    whiteRatio: 0.1082,
    darkRatio: 0.0653,
    skinRatio: 0.0158,
    saturatedColorRatio: 0.0303,
    blackBarRatio: 0.0077,
  }, "payoff");

  assert.equal(evidence.visibilityVerdict, "failed");
  assert.equal(evidence.playerCloseupOnly, true);
  assert.ok(evidence.reasons.includes("semantic_player_closeup_only"));
});

test("semantic goal visibility rejects captioned celebration finish frames", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.6797,
    whiteRatio: 0.0399,
    darkRatio: 0.054,
    skinRatio: 0.0161,
    saturatedColorRatio: 0.613,
    blackBarRatio: 0.0001,
  }, "finish");

  assert.equal(evidence.visibilityVerdict, "failed");
  assert.equal(evidence.playerCloseupOnly, true);
  assert.ok(evidence.reasons.includes("semantic_player_closeup_only"));
});

test("semantic goal visibility rejects rendered goal 4 caption/closeup finish frames", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.6464,
    whiteRatio: 0.0588,
    darkRatio: 0.0554,
    skinRatio: 0.0407,
    saturatedColorRatio: 0.3477,
    blackBarRatio: 0,
  }, "finish");

  assert.equal(evidence.visibilityVerdict, "failed");
  assert.equal(evidence.playerCloseupOnly, true);
  assert.ok(evidence.reasons.includes("semantic_player_closeup_only"));
});

test("semantic goal visibility rejects rendered goal 4 caption/closeup payoff frames", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.5109,
    whiteRatio: 0.0785,
    darkRatio: 0.0354,
    skinRatio: 0.0586,
    saturatedColorRatio: 0.2395,
    blackBarRatio: 0.0002,
  }, "payoff");

  assert.equal(evidence.visibilityVerdict, "failed");
  assert.equal(evidence.playerCloseupOnly, true);
  assert.ok(evidence.reasons.includes("semantic_player_closeup_only"));
});

test("semantic goal visibility rejects rendered goal 4 low-saturation closeup frames", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.6663,
    whiteRatio: 0.0187,
    darkRatio: 0.1323,
    skinRatio: 0.018,
    saturatedColorRatio: 0.0149,
    blackBarRatio: 0.0022,
  }, "finish");

  assert.equal(evidence.visibilityVerdict, "failed");
  assert.equal(evidence.playerCloseupOnly, true);
  assert.ok(evidence.reasons.includes("semantic_player_closeup_only"));
});

test("semantic goal visibility rejects dark sideline celebration closeup selected as goal 4 finish", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.4175,
    whiteRatio: 0.0193,
    darkRatio: 0.2898,
    skinRatio: 0.0295,
    saturatedColorRatio: 0.0313,
    blackBarRatio: 0.0624,
  }, "finish");

  assert.equal(evidence.visibilityVerdict, "failed");
  assert.equal(evidence.playerCloseupOnly, true);
  assert.ok(evidence.reasons.includes("semantic_player_closeup_only"));
});

test("semantic goal visibility rejects scoreboard-only frames", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.01,
    whiteRatio: 0.12,
    darkRatio: 0.35,
    skinRatio: 0,
    saturatedColorRatio: 0.04,
    blackBarRatio: 0.02,
  }, "confirmation");

  assert.equal(evidence.visibilityVerdict, "failed");
  assert.equal(evidence.scoreboardOnly, true);
  assert.ok(evidence.reasons.includes("semantic_scoreboard_only"));
});

test("semantic goal visibility preserves safe existing clear evidence", async () => {
  const result = await analyzeSemanticGoalFrames({
    roleWindows: [{ role: "finish" }],
    frames: [{
      semanticGoalEvidence: {
        visibilityVerdict: "clear",
        visibleGoal: true,
        hasVisibleFinish: true,
        hasBallInNetOrPayoff: true,
      },
    }],
  });

  assert.equal(result.clearFrameCount, 1);
  assert.equal(result.frameEvidence[0].visibilityVerdict, "clear");
});

test("semantic goal visibility skips decode when existing evidence is present", async () => {
  const result = await analyzeSemanticGoalFrames({
    roleWindows: [{ role: "finish" }],
    frames: [{
      localPath: "/unsafe/path/that/should/not/be/read.jpg",
      semanticGoalEvidence: {
        visibilityVerdict: "clear",
        visibleGoal: true,
        hasVisibleFinish: true,
        hasBallInNetOrPayoff: true,
      },
    }],
    runner: async () => {
      throw new Error("runner should not be called");
    },
  });

  assert.equal(result.clearFrameCount, 1);
  assert.equal(result.frameEvidence[0].providerMode, "semantic-existing-evidence");
});

test("semantic goal visibility can force fresh analysis for ffmpeg rendered frames", async () => {
  const result = await analyzeSemanticGoalFrames({
    roleWindows: [{ role: "finish" }],
    frames: [{
      localPath: "/unsafe/path/that/should/fail.jpg",
      source: "ffmpeg",
      semanticGoalEvidence: {
        visibilityVerdict: "clear",
        visibleGoal: true,
        hasVisibleFinish: true,
        hasBallInNetOrPayoff: true,
      },
    }],
    ignoreExistingEvidence: true,
  });

  assert.equal(result.clearFrameCount, 0);
  assert.equal(result.frameEvidence[0].visibilityVerdict, "failed");
  assert.equal(result.frameEvidence[0].reasons.includes("semantic_frame_path_unsafe"), true);
});

test("semantic goal visibility rejects existing replay evidence", async () => {
  const result = await analyzeSemanticGoalFrames({
    roleWindows: [{ role: "finish" }],
    frames: [{
      semanticGoalEvidence: {
        visibilityVerdict: "clear",
        visibleGoal: true,
        replayOnly: true,
      },
    }],
  });

  assert.equal(result.clearFrameCount, 0);
  assert.equal(result.frameEvidence[0].visibilityVerdict, "failed");
});

test("semantic goal visibility analyzes frames with bounded parallelism", async () => {
  let active = 0;
  let maxActive = 0;
  const roles = ["pre_shot", "finish", "payoff", "confirmation", "finish", "payoff"];
  const result = await analyzeSemanticGoalFrames({
    roleWindows: roles.map((role) => ({ role })),
    frames: roles.map((role, index) => ({ id: `frame_${index}`, role })),
    maxConcurrency: 3,
    frameAnalyzer: async (_frame, role) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return {
        role,
        visibilityVerdict: "clear",
        visibleGoal: true,
        hasVisibleFinish: role === "finish",
        hasBallInNetOrPayoff: ["finish", "payoff"].includes(role),
        hasGoalMouth: true,
        confidence: 0.9,
        reasons: [],
        roles: [role],
      };
    },
  });

  assert.equal(maxActive <= 3, true);
  assert.deepEqual(result.frameEvidence.map((item) => item.role), roles);
  assert.equal(result.clearFrameCount, roles.length);
});
