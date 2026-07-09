const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

const {
  analyzeRgbBuffer,
  analyzeSemanticGoalFrames,
  classifyFeatures,
} = require("../server/semantic-goal-visibility.cjs");
const { storagePath } = require("../server/storage.cjs");

function rgbFrame({ width = 72, height = 128, fill = [0, 0, 0], paint = () => null } = {}) {
  const buffer = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const color = paint(x, y) || fill;
      buffer[offset] = color[0];
      buffer[offset + 1] = color[1];
      buffer[offset + 2] = color[2];
    }
  }
  return buffer;
}

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

test("semantic goal visibility accepts score-change-backed wide live finish frames", () => {
  const finishEvidence = classifyFeatures({
    greenRatio: 0.6769,
    whiteRatio: 0.0117,
    darkRatio: 0.011,
    skinRatio: 0.0043,
    saturatedColorRatio: 0.062,
    blackBarRatio: 0.0008,
    activeContentRatio: 0.9992,
  }, "finish");
  const payoffEvidence = classifyFeatures({
    greenRatio: 0.7053,
    whiteRatio: 0.0103,
    darkRatio: 0.0116,
    skinRatio: 0.0052,
    saturatedColorRatio: 0.0691,
    blackBarRatio: 0.0008,
    activeContentRatio: 0.9992,
  }, "payoff");

  assert.equal(finishEvidence.visibilityVerdict, "clear");
  assert.equal(finishEvidence.hasVisibleFinish, true);
  assert.equal(finishEvidence.hasBallInNetOrPayoff, true);
  assert.equal(payoffEvidence.visibilityVerdict, "clear");
  assert.equal(payoffEvidence.hasBallInNetOrPayoff, true);
});

test("semantic goal visibility ignores letterbox bars when measuring rendered action frames", () => {
  const buffer = rgbFrame({
    paint: (x, y) => {
      if (y < 45 || y > 82) return [0, 0, 0];
      if (x >= 26 && x <= 44 && y >= 58 && y <= 64) return [238, 238, 230];
      if ((x + y) % 17 === 0) return [195, 195, 185];
      return [38, 124, 42];
    },
  });
  const features = analyzeRgbBuffer(buffer);
  const evidence = classifyFeatures(features, "finish");

  assert.equal(features.blackBarRatio > 0.6, true);
  assert.equal(features.activeContentRatio < 0.4, true);
  assert.equal(evidence.visibilityVerdict, "clear");
  assert.equal(evidence.hasVisibleFinish, true);
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

test("semantic goal visibility rejects actual rendered bench celebration false positives", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.3008,
    whiteRatio: 0.0211,
    darkRatio: 0.2244,
    skinRatio: 0.1061,
    saturatedColorRatio: 0.0454,
    blackBarRatio: 0.6819,
  }, "finish");

  assert.equal(evidence.visibilityVerdict, "failed");
  assert.equal(evidence.playerCloseupOnly, true);
  assert.ok(evidence.reasons.includes("semantic_player_closeup_only"));
});

test("semantic goal visibility rejects sideline bench frames with goalmouth-like green", () => {
  const finishEvidence = classifyFeatures({
    greenRatio: 0.3107,
    whiteRatio: 0.0204,
    darkRatio: 0.2568,
    skinRatio: 0.0616,
    saturatedColorRatio: 0.0559,
    blackBarRatio: 0.0974,
  }, "finish");
  const payoffEvidence = classifyFeatures({
    greenRatio: 0.2928,
    whiteRatio: 0.0215,
    darkRatio: 0.2881,
    skinRatio: 0.0601,
    saturatedColorRatio: 0.051,
    blackBarRatio: 0.0806,
  }, "payoff");

  assert.equal(finishEvidence.visibilityVerdict, "failed");
  assert.equal(finishEvidence.playerCloseupOnly, true);
  assert.ok(finishEvidence.reasons.includes("semantic_player_closeup_only"));
  assert.equal(payoffEvidence.visibilityVerdict, "failed");
  assert.equal(payoffEvidence.playerCloseupOnly, true);
  assert.ok(payoffEvidence.reasons.includes("semantic_player_closeup_only"));
});

test("semantic goal visibility rejects actual rendered green-only player closeup false positives", () => {
  const evidence = classifyFeatures({
    greenRatio: 0.7874,
    whiteRatio: 0.0549,
    darkRatio: 0.0602,
    skinRatio: 0.009,
    saturatedColorRatio: 0.0203,
    blackBarRatio: 0.6739,
  }, "payoff");

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

test("semantic goal visibility rejects the latest rendered goal 4 saturated closeup false positive", () => {
  const finishEvidence = classifyFeatures({
    greenRatio: 0.6597,
    whiteRatio: 0.0709,
    darkRatio: 0.0543,
    skinRatio: 0.0287,
    saturatedColorRatio: 0.4448,
    blackBarRatio: 0.0648,
    activeContentRatio: 0.9352,
  }, "finish");
  const payoffEvidence = classifyFeatures({
    greenRatio: 0.6381,
    whiteRatio: 0.0669,
    darkRatio: 0.0589,
    skinRatio: 0.0344,
    saturatedColorRatio: 0.4299,
    blackBarRatio: 0.0645,
    activeContentRatio: 0.9355,
  }, "payoff");

  assert.equal(finishEvidence.visibilityVerdict, "failed");
  assert.equal(finishEvidence.playerCloseupOnly, true);
  assert.ok(finishEvidence.reasons.includes("semantic_player_closeup_only"));
  assert.equal(payoffEvidence.visibilityVerdict, "failed");
  assert.equal(payoffEvidence.playerCloseupOnly, true);
  assert.ok(payoffEvidence.reasons.includes("semantic_player_closeup_only"));
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

test("semantic goal visibility crops rendered portrait proof frames to the central action strip", async () => {
  const framePath = storagePath("staging", `semantic-goal-visibility-${process.pid}.jpg`);
  mkdirSync(dirname(framePath), { recursive: true });
  writeFileSync(framePath, Buffer.from([1, 2, 3]));

  let receivedFilter = "";
  const clearActionBuffer = rgbFrame({
    paint: (x, y) => {
      if (x >= 28 && x <= 44 && y >= 50 && y <= 72) return [238, 238, 230];
      if ((x + y) % 19 === 0) return [196, 196, 184];
      return [42, 128, 44];
    },
  });
  const runner = (_bin, args, _options, callback) => {
    receivedFilter = args[args.indexOf("-vf") + 1];
    callback(null, clearActionBuffer);
  };

  const result = await analyzeSemanticGoalFrames({
    roleWindows: [{ role: "finish" }],
    frames: [{
      localPath: framePath,
      source: "ffmpeg",
      width: 360,
      height: 640,
      semanticGoalEvidence: {
        visibilityVerdict: "failed",
        visibleGoal: false,
      },
    }],
    runner,
    ignoreExistingEvidence: true,
  });

  assert.equal(receivedFilter.startsWith("crop=iw:ih*0.34"), true);
  assert.equal(result.clearFrameCount, 1);
  assert.equal(result.frameEvidence[0].visibilityVerdict, "clear");
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
