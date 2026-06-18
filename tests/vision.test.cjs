const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeVision,
  analyzeFrames,
  createVisionProvider,
  inferLabelsForFrame,
  frameToVisualWindow,
  publicVisualSignals,
  reasonCodeForVisualType,
  validateVisualSignals,
  visionHealth,
  visualHighlightTypeForReasons,
  visualReasonCodesForWindow,
} = require("../server/vision.cjs");

const metadata = { durationSeconds: 20, width: 1920, height: 1080 };

test("visual signal validation normalizes safe action windows", () => {
  const signals = validateVisualSignals({
    providerMode: "fixture-provider",
    fallbackUsed: false,
    windows: [
      {
        start: 7.2,
        end: 10.4,
        types: ["shot_like_motion", "goal_area_visible", "ball_visible"],
        confidence: 0.91,
        source: "fixture",
      },
    ],
  }, metadata);

  assert.equal(signals.summary.goalClaimAllowed, false);
  assert.deepEqual(visualReasonCodesForWindow(signals.windows[0]), [
    "visual_shot_like_motion",
    "visual_goal_area",
    "visual_ball_visible",
  ]);
  assert.equal(signals.summary.actionFocusConfidence, 0.91);
});

test("visual reasons map to non-goal football moment types", () => {
  assert.equal(reasonCodeForVisualType("save_like_motion"), "visual_save_like_motion");
  assert.equal(reasonCodeForVisualType("crowd_reaction"), "visual_crowd_reaction");
  assert.equal(reasonCodeForVisualType("scoreboard_context"), "visual_scoreboard_context");
  assert.equal(reasonCodeForVisualType("ball_toward_goal"), "visual_ball_toward_goal");
  assert.equal(reasonCodeForVisualType("ball_in_net"), "visual_ball_in_net");
  assert.equal(reasonCodeForVisualType("celebration_after_shot"), "visual_celebration_after_shot");
  assert.equal(reasonCodeForVisualType("referee_no_goal_signal"), "visual_referee_no_goal_signal");
  assert.equal(reasonCodeForVisualType("referee_goal_signal"), "visual_referee_goal_signal");
  assert.equal(reasonCodeForVisualType("var_check_graphic"), "visual_var_check");
  assert.equal(reasonCodeForVisualType("var_decision_graphic"), "visual_var_decision");
  assert.equal(reasonCodeForVisualType("scoreboard_goal_removed"), "visual_scoreboard_goal_removed");
  assert.equal(reasonCodeForVisualType("scoreboard_goal_confirmed"), "visual_scoreboard_goal_confirmed");
  assert.equal(reasonCodeForVisualType("offside_line_replay"), "visual_offside_line");
  assert.equal(reasonCodeForVisualType("replay_angle"), "visual_replay_angle");
  assert.equal(visualHighlightTypeForReasons(["visual_shot_like_motion", "visual_goal_area"]), "big_chance");
  assert.equal(visualHighlightTypeForReasons(["visual_ball_toward_goal", "visual_goal_mouth"]), "big_chance");
  assert.equal(visualHighlightTypeForReasons(["visual_save_like_motion"]), "save");
  assert.equal(visualHighlightTypeForReasons(["visual_foul_like_contact"]), "foul");
  assert.equal(visualHighlightTypeForReasons(["visual_crowd_reaction"]), "crowd_reaction");
  assert.equal(visualHighlightTypeForReasons(["visual_goal_area"]), "unknown_action");
});

test("visual validation accepts decision signals without enabling goal claims", () => {
  const signals = validateVisualSignals({
    providerMode: "fixture-provider",
    fallbackUsed: false,
    windows: [
      {
        start: 11,
        end: 14,
        types: ["var_check_graphic", "offside_line_replay", "referee_no_goal_signal", "scoreboard_goal_removed"],
        confidence: 0.88,
        source: "fixture",
      },
    ],
  }, metadata);

  assert.equal(signals.summary.goalClaimAllowed, false);
  assert.equal(signals.summary.varCheckGraphic.present, true);
  assert.equal(signals.summary.offsideLineReplay.present, true);
  assert.equal(signals.summary.refereeNoGoalSignal.present, true);
  assert.equal(signals.summary.scoreboardGoalRemoved.present, true);
  assert.deepEqual(visualReasonCodesForWindow(signals.windows[0]), [
    "visual_var_check",
    "visual_offside_line",
    "visual_referee_no_goal_signal",
    "visual_scoreboard_goal_removed",
  ]);
});

test("visual validation accepts explicit goal-sequence cues without accepting raw goal labels", () => {
  const signals = validateVisualSignals({
    providerMode: "fixture-provider",
    fallbackUsed: false,
    windows: [
      {
        start: 6,
        end: 9,
        types: ["shot_contact", "ball_toward_goal", "goal_mouth_visible", "ball_visible"],
        confidence: 0.9,
      },
      {
        start: 9,
        end: 12,
        types: ["ball_in_net", "celebration_after_shot"],
        confidence: 0.88,
      },
    ],
  }, metadata);

  assert.equal(signals.summary.goalClaimAllowed, false);
  assert.equal(signals.summary.ballTowardGoal.present, true);
  assert.equal(signals.summary.ballInNet.present, true);
  assert.equal(signals.summary.celebrationAfterShot.present, true);
  assert.deepEqual(visualReasonCodesForWindow(signals.windows[0]), [
    "visual_shot_contact",
    "visual_ball_toward_goal",
    "visual_goal_mouth",
    "visual_ball_visible",
  ]);
});

test("visual validation keeps late critical goal windows for long sources", () => {
  const earlyFiller = Array.from({ length: 26 }, (_, index) => ({
    start: 6 + index * 7,
    end: 8 + index * 7,
    labels: index % 3 === 0 ? ["shot_like_motion", "ball_visible"] : ["crowd_reaction"],
    confidence: 0.78 + (index % 4) * 0.03,
  }));
  const lateGoalEvidence = [
    { start: 246, end: 247.6, labels: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.88 },
    { start: 250, end: 251.7, labels: ["goal_mouth_visible", "ball_in_net"], confidence: 0.9 },
    { start: 263, end: 264.4, labels: ["scoreboard_goal_confirmed", "referee_goal_signal"], confidence: 0.86 },
    { start: 318, end: 319.5, labels: ["shot_contact", "ball_toward_goal", "ball_visible"], confidence: 0.89 },
    { start: 322, end: 323.6, labels: ["goal_mouth_visible", "ball_in_net"], confidence: 0.91 },
    { start: 336, end: 337.3, labels: ["scoreboard_goal_confirmed", "referee_goal_signal"], confidence: 0.87 },
  ];

  const signals = validateVisualSignals({
    providerMode: "fixture-provider",
    fallbackUsed: false,
    windows: [...earlyFiller, ...lateGoalEvidence],
  }, { durationSeconds: 360, width: 1920, height: 1080 });
  const lateReasons = signals.windows
    .filter((window) => window.start >= 240)
    .flatMap(visualReasonCodesForWindow);

  assert.ok(signals.windows.length <= 24);
  assert.ok(lateReasons.includes("visual_shot_contact"));
  assert.ok(lateReasons.includes("visual_ball_in_net"));
  assert.ok(lateReasons.includes("visual_scoreboard_goal_confirmed"));
  assert.equal(signals.summary.goalClaimAllowed, false);
});

test("safe heuristic frame analysis does not claim tracking or goals", async () => {
  const result = await analyzeFrames({
    inputPath: "/Users/example/private.mp4",
    metadata,
    candidateWindows: [{ time: 8.1, confidence: 0.74, source: "signal_cluster" }],
  });

  assert.equal(result.providerMode, "safe-heuristic");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.summary.goalClaimAllowed, false);
  assert.equal(result.windows[0].type, "unknown_visual_action");
  assert.doesNotMatch(JSON.stringify(publicVisualSignals(result)), /\/Users|private\.mp4|secret/i);
});

test("local frame inspection adapter uses sampled frames without leaking paths", async () => {
  const result = await analyzeFrames({
    metadata,
    frames: [
      {
        id: "frame_1",
        timestamp: 8,
        windowStart: 6.5,
        windowEnd: 9.5,
        width: 640,
        height: 360,
        localPath: "/Users/example/private-frame.jpg",
        source: "sampled_frame",
      },
    ],
    candidateWindows: [{ time: 8, confidence: 0.81, source: "motion_candidate", visualHints: ["save_like_motion"] }],
  });

  assert.equal(result.providerMode, "frame-inspection-local");
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.summary.goalClaimAllowed, false);
  assert.equal(result.windows[0].types.includes("save_like_motion"), true);
  assert.doesNotMatch(JSON.stringify(publicVisualSignals(result)), /\/Users|private-frame|localPath|secret/i);
});

test("local frame inspection adapter can infer crowd context from sampled frames and audio", async () => {
  const result = await analyzeVision({
    metadata,
    mediaSignals: {
      audioPeaks: [{ time: 8, energyScore: 0.91 }],
      sceneChanges: [{ time: 8.2, confidence: 0.75 }],
    },
    frames: [
      {
        id: "frame_1",
        timestamp: 8,
        windowStart: 6.8,
        windowEnd: 9.6,
        width: 640,
        height: 360,
        localPath: "/Users/example/private-frame.jpg",
        source: "audio_peak_context",
      },
    ],
    candidateWindows: [{ time: 8, confidence: 0.6, source: "audio_peak_context" }],
  });

  assert.equal(result.providerMode, "frame-inspection-local");
  assert.equal(result.summary.crowdReaction.present, true);
  assert.equal(result.summary.goalClaimAllowed, false);
  assert.deepEqual(visualReasonCodesForWindow(result.windows[0]), ["visual_crowd_reaction"]);
});

test("local frame inspection promotes post-opening high motion to safe chance context", async () => {
  const result = await analyzeVision({
    metadata: { durationSeconds: 140, width: 1920, height: 1080 },
    mediaSignals: {
      durationSeconds: 140,
      audioPeaks: [{ time: 62, energyScore: 0.9 }],
      sceneChanges: [{ time: 62.1, confidence: 0.76 }],
    },
    frames: [
      {
        id: "frame_1",
        timestamp: 62,
        windowStart: 60.5,
        windowEnd: 63.5,
        width: 640,
        height: 360,
        localPath: "/Users/example/private-frame.jpg",
        source: "signal_cluster",
      },
    ],
    candidateWindows: [{ time: 62, confidence: 0.74, source: "signal_cluster" }],
  });

  assert.equal(result.providerMode, "frame-inspection-local");
  assert.equal(result.summary.shotLikeMotion.present, true);
  assert.equal(result.summary.ballPresence.present, true);
  assert.equal(result.summary.goalClaimAllowed, false);
  assert.equal(visualHighlightTypeForReasons(visualReasonCodesForWindow(result.windows[0])), "big_chance");
  assert.doesNotMatch(JSON.stringify(publicVisualSignals(result)), /\/Users|private-frame|localPath|secret/i);
});

test("local frame inspection keeps opening high motion neutral without action hints", () => {
  const labels = inferLabelsForFrame(
    {
      id: "frame_opening",
      timestamp: 8,
      width: 640,
      height: 360,
      source: "signal_cluster",
    },
    [{ time: 8, confidence: 0.8, source: "signal_cluster" }],
    {
      durationSeconds: 140,
      audioPeaks: [{ time: 8, energyScore: 0.91 }],
      sceneChanges: [{ time: 8.1, confidence: 0.76 }],
    },
  );

  assert.equal(labels.includes("shot_like_motion"), false);
  assert.equal(labels.includes("ball_visible"), false);
  assert.ok(labels.includes("crowd_reaction") || labels.includes("unknown_visual_action"));
});

test("frameToVisualWindow rejects malformed frames and never infers goals", () => {
  assert.equal(frameToVisualWindow({ timestamp: 2, width: 0, height: 360 }, [], metadata), null);
  const window = frameToVisualWindow(
    { timestamp: 5, windowStart: 4, windowEnd: 6, width: 640, height: 360, source: "sampled_frame" },
    [],
    metadata,
  );
  assert.equal(window.type, "unknown_visual_action");
  assert.equal(window.evidence.goalClaimAllowed, false);
});

test("visual validation rejects visual-only goal labels", () => {
  assert.throws(
    () => validateVisualSignals({
      providerMode: "bad-provider",
      fallbackUsed: false,
      windows: [{ start: 2, end: 4, labels: ["goal"], confidence: 0.9 }],
    }, metadata),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );
});

test("visual validation rejects unknown provider labels instead of downgrading", () => {
  assert.throws(
    () => validateVisualSignals({
      providerMode: "bad-provider",
      fallbackUsed: false,
      windows: [{ start: 2, end: 4, labels: ["ball_tracker_secret"], confidence: 0.9 }],
    }, metadata),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );
});

test("mock vision provider returns deterministic safe labels", async () => {
  const result = await analyzeVision({
    providerMode: "mock-vision-provider",
    metadata,
    mockLabels: ["fast_break_motion"],
    candidateWindows: [{ time: 8, confidence: 0.8, source: "fixture" }],
  });
  assert.equal(result.providerMode, "mock-vision-provider");
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.windows[0].type, "fast_break_motion");
  assert.equal(result.providerMetadata.frameCount, 0);
  assert.equal(result.summary.goalClaimAllowed, false);
});

test("external vision provider adapter is opt-in and falls back safely without a client", async () => {
  const provider = createVisionProvider({ mode: "external" });
  assert.equal(provider.health().ready, false);
  assert.equal(provider.health().networkRequired, false);

  const result = await provider.analyzeFrames({
    metadata,
    candidateWindows: [{ time: 8.1, confidence: 0.74, source: "signal_cluster" }],
  });
  assert.equal(result.providerMode, "safe-heuristic");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.failure.code, "VISION_PROVIDER_DISABLED");
});

test("external vision provider adapter validates injected provider output", async () => {
  const provider = createVisionProvider({
    mode: "external",
    client: {
      analyzeFrames: async () => ({
        confidence: 0.82,
        windows: [{ start: 3, end: 6, type: "foul_like_contact", confidence: 0.82, source: "fixture-client" }],
      }),
    },
  });

  assert.equal(provider.health().ready, true);
  assert.equal(provider.health().networkRequired, true);
  const result = await provider.analyzeFrames({ metadata });
  assert.equal(result.providerMode, "external-vision-adapter");
  assert.equal(result.windows[0].type, "foul_like_contact");
  assert.equal(result.summary.goalClaimAllowed, false);
});

test("external vision provider fails closed on unknown labels", async () => {
  const provider = createVisionProvider({
    mode: "external",
    client: {
      analyzeFrames: async () => ({
        confidence: 0.82,
        windows: [{ start: 3, end: 6, type: "goalish_provider_label", confidence: 0.82 }],
      }),
    },
  });

  await assert.rejects(
    () => provider.analyzeFrames({ metadata }),
    (error) => error.code === "AI_OUTPUT_INVALID",
  );
});

test("external vision provider runtime failure falls back without raw provider leakage", async () => {
  const provider = createVisionProvider({
    mode: "external",
    client: {
      analyzeFrames: async () => {
        const error = new Error("/Users/example OPENAI_API_KEY=secret provider failed");
        error.code = "VISION_UPSTREAM_FAILED";
        throw error;
      },
    },
  });

  const result = await provider.analyzeFrames({
    metadata,
    candidateWindows: [{ time: 8.1, confidence: 0.74, source: "signal_cluster" }],
  });
  assert.equal(result.providerMode, "safe-heuristic");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.failure.code, "VISION_UPSTREAM_FAILED");
  assert.doesNotMatch(JSON.stringify(publicVisualSignals(result)), /\/Users|OPENAI_API_KEY|secret|provider failed/i);
});

test("external vision provider timeout falls back with bounded safe metadata", async () => {
  const provider = createVisionProvider({
    mode: "external",
    client: {
      analyzeFrames: async () => new Promise(() => {}),
    },
  });
  const result = await provider.analyzeFrames({
    metadata,
    timeoutMs: 10,
    frames: [{ timestamp: 8, windowStart: 7, windowEnd: 9, width: 640, height: 360 }],
    candidateWindows: [{ time: 8, confidence: 0.74, source: "signal_cluster" }],
  });

  assert.equal(result.providerMode, "safe-heuristic");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.failure.code, "VISION_PROVIDER_TIMEOUT");
  assert.equal(result.providerMetadata.providerTimedOut, true);
  assert.equal(result.providerMetadata.frameCount, 1);
});

test("external vision provider cancellation stops before provider work", async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = createVisionProvider({
    mode: "external",
    client: { analyzeFrames: async () => ({ windows: [] }) },
  });

  await assert.rejects(
    () => provider.analyzeFrames({ metadata, signal: controller.signal }),
    (error) => error.code === "JOB_CANCELLED",
  );
});

test("external vision provider cancellation interrupts pending provider work", async () => {
  const controller = new AbortController();
  const provider = createVisionProvider({
    mode: "external",
    client: { analyzeFrames: async () => new Promise(() => {}) },
  });
  const pending = provider.analyzeFrames({ metadata, signal: controller.signal, timeoutMs: 1000 });
  setTimeout(() => controller.abort(), 5);

  await assert.rejects(
    () => pending,
    (error) => error.code === "JOB_CANCELLED",
  );
});

test("vision health is safe and explicit about heuristic mode", () => {
  const health = visionHealth();
  assert.equal(health.ready, true);
  assert.equal(health.defaultProvider, "frame-inspection-local");
  assert.equal(health.externalProviderEnabled, false);
  assert.equal(health.fallbackAvailable, true);
  assert.equal(health.allowedLabels.includes("crowd_reaction"), true);
  assert.equal(health.objectTracking, false);
  assert.equal(health.goalClaimAllowed, false);
  assert.equal(health.features.includes("safe_no_goal_inference"), true);
  assert.doesNotMatch(JSON.stringify(health), /\/Users|storageKey|secret/i);
});
