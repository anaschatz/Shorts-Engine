const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analysisHealth,
  createCandidateEditPlans,
  detectHighlights,
  extractMediaSignals,
  reasonCodesForCaption,
} = require("../server/analysis.cjs");
const { hasGoalLanguage } = require("../server/edit-plan.cjs");
const {
  MockTranscriptionProvider,
  OpenAITranscriptionProvider,
  chooseTranscriptionProvider,
  normalizeLanguageCode,
} = require("../server/transcription.cjs");

const metadata = {
  durationSeconds: 22,
  width: 1920,
  height: 1080,
  hasAudio: true,
};

const transcript = {
  provider: "fixture",
  language: "en",
  captions: [
    { start: 1, end: 2.8, text: "The build up starts from the left side" },
    { start: 7.4, end: 9.6, text: "WHAT A GOAL! The keeper cannot reach the finish" },
    { start: 14.2, end: 16, text: "Replay this angle and watch the assist lane" },
  ],
};

test("media signal extraction can use mocked FFmpeg scene and audio outputs", async () => {
  const fakeRunner = async (args) => {
    const text = args.join(" ");
    if (text.includes("showinfo")) {
      return { stderr: "n:1 pts_time:3.24 pos:1\nn:2 pts_time:8.44 pos:2\n" };
    }
    return { stderr: "silence_start: 0.25\nsilence_end: 1.00\nsilence_start: 10.00\nsilence_end: 13.50\n" };
  };
  const signals = await extractMediaSignals({ inputPath: "/tmp/input.mp4", metadata, ffmpegRunner: fakeRunner });
  assert.equal(signals.durationSeconds, 22);
  assert.equal(signals.aspectRatio, 1.778);
  assert.equal(signals.sceneChanges[0].time, 3.24);
  assert.ok(signals.audioPeaks.some((peak) => peak.time > 5 && peak.time < 10));
});

test("highlight detection ranks confirmed goal moments first", () => {
  const signals = {
    durationSeconds: 22,
    hasAudio: true,
    audioPeaks: [{ time: 8.5, energyScore: 0.92, source: "fixture" }],
    sceneChanges: [{ time: 8.4, confidence: 0.81, source: "fixture" }],
  };
  const result = detectHighlights({ transcript, signals, preset: "hype" });
  assert.equal(result.fallback, false);
  assert.equal(result.moments[0].highlightType, "goal");
  assert.equal(result.moments[0].reasonCodes.includes("goal"), true);
  assert.equal(result.moments[0].reasonCodes.includes("audio_energy_spike"), true);
  assert.ok(result.moments[0].retentionScore > result.moments[1].retentionScore);
});

test("candidate edit plans are validated 9:16 MP4 exports", () => {
  const signals = {
    durationSeconds: 22,
    hasAudio: true,
    audioPeaks: [{ time: 8.5, energyScore: 0.92, source: "fixture" }],
    sceneChanges: [{ time: 8.4, confidence: 0.81, source: "fixture" }],
  };
  const { moments } = detectHighlights({ transcript, signals, preset: "hype" });
  const plans = createCandidateEditPlans({ moments, metadata, transcript, title: "Fixture Derby", preset: "hype" });
  assert.ok(plans.length >= 2);
  assert.equal(plans[0].aspectRatio, "9:16");
  assert.equal(plans[0].export.width, 1080);
  assert.equal(plans[0].export.height, 1920);
  assert.equal(plans[0].highlightType, "goal");
  assert.equal(plans[0].stylePreset, "social_sports_v1");
  assert.equal(plans[0].framingMode, "wide_safe_vertical");
  assert.equal(plans[0].cropStrategy.preserveFullFrame, true);
  assert.ok(plans[0].captionEmphasis.length > 0);
  assert.ok(plans[0].animationCues.length > 0);
  assert.equal(plans[0].reasonCodes.includes("goal"), true);
});

test("reason code extraction recognizes football and replay signals", () => {
  const reasons = reasonCodesForCaption(
    { start: 5, end: 7, text: "Replay the GOAL angle and the crowd roar!" },
    {
      audioPeaks: [{ time: 6, energyScore: 0.9 }],
      sceneChanges: [{ time: 6.2, confidence: 0.8 }],
    },
  );
  assert.equal(reasons.includes("goal"), true);
  assert.equal(reasons.includes("replay_worthy_moment"), true);
  assert.equal(reasons.includes("crowd_reaction"), true);
  assert.equal(reasons.includes("audio_energy_spike"), true);
  assert.equal(reasons.includes("commentator_peak"), true);
});

test("audio-only spike is not promoted to goal without semantic evidence", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [{ start: 9, end: 11, text: "Listen to that reaction from the stands" }],
    },
    signals: {
      durationSeconds: 24,
      hasAudio: true,
      audioPeaks: [{ time: 10, energyScore: 0.95, source: "fixture" }],
      sceneChanges: [{ time: 10.1, confidence: 0.75, source: "fixture" }],
    },
    preset: "hype",
  });
  assert.equal(result.moments[0].highlightType, "crowd_reaction");
  assert.equal(result.moments[0].reasonCodes.includes("goal"), false);
  assert.equal(hasGoalLanguage(result.moments[0].hook), false);
});

test("visual shot-like evidence ranks a big chance without inventing a goal", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [{ start: 7, end: 8.5, text: "The pressure rises in the box" }],
    },
    signals: {
      durationSeconds: 20,
      hasAudio: true,
      audioPeaks: [],
      sceneChanges: [],
    },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [
        {
          start: 6.8,
          end: 10.2,
          types: ["shot_like_motion", "goal_area_visible", "ball_visible"],
          confidence: 0.86,
        },
      ],
    },
    preset: "hype",
  });

  assert.equal(result.moments[0].highlightType, "big_chance");
  assert.equal(result.moments[0].reasonCodes.includes("visual_shot_like_motion"), true);
  assert.equal(result.moments[0].reasonCodes.includes("goal"), false);
  assert.equal(result.moments[0].evidence.visual.goalClaimAllowed, false);
  assert.equal(hasGoalLanguage(result.moments[0].hook), false);
});

test("candidate plans include visual evidence summary and safe framing reason", () => {
  const result = detectHighlights({
    transcript: {
      provider: "fixture",
      language: "en",
      captions: [{ start: 10, end: 11.4, text: "Everyone reacts to the save" }],
    },
    signals: { durationSeconds: 22, hasAudio: true, audioPeaks: [], sceneChanges: [] },
    visualSignals: {
      providerMode: "fixture-visual",
      fallbackUsed: false,
      windows: [{ start: 9.7, end: 12.8, type: "save_like_motion", confidence: 0.88 }],
    },
    preset: "hype",
  });
  const plans = createCandidateEditPlans({ moments: result.moments, metadata, transcript: { captions: [] }, title: "Save clip" });

  assert.equal(plans[0].highlightType, "save");
  assert.equal(plans[0].visualEvidenceSummary.goalClaimAllowed, false);
  assert.equal(plans[0].visualEvidenceSummary.topTypes.includes("save_like_motion"), true);
  assert.equal(plans[0].actionFocusConfidence, 0.88);
  assert.match(plans[0].framingReason, /^wide_safe_/);
  assert.equal(plans[0].framingMode, "wide_safe_vertical");
  assert.equal(plans[0].cropStrategy.preserveFullFrame, true);
});

test("finish phrasing alone is not goal evidence", () => {
  const reasons = reasonCodesForCaption(
    { start: 3, end: 5, text: "What a finish" },
    {
      audioPeaks: [{ time: 4, energyScore: 0.9 }],
      sceneChanges: [{ time: 4.1, confidence: 0.8 }],
    },
  );
  assert.equal(reasons.includes("goal"), false);
  assert.equal(hasGoalLanguage("What a finish"), false);
});

test("mock fallback transcription does not invent goal captions", async () => {
  const provider = chooseTranscriptionProvider({ forceMock: true });
  const result = await provider.transcribe({ metadata, preset: "hype", language: "English" });
  const text = result.captions.map((caption) => caption.text).join(" ");
  assert.equal(hasGoalLanguage(text), false);
  assert.doesNotMatch(text, /finish/i);
});

test("save and foul language map to football-aware non-goal types", () => {
  const saveReasons = reasonCodesForCaption(
    { start: 11, end: 13, text: "Huge save by the keeper after the shot!" },
    { audioPeaks: [{ time: 12, energyScore: 0.9 }], sceneChanges: [{ time: 12, confidence: 0.8 }] },
  );
  assert.equal(saveReasons.includes("save"), true);
  assert.equal(saveReasons.includes("shot_on_target"), true);
  assert.equal(saveReasons.includes("goal"), false);

  const foulReasons = reasonCodesForCaption(
    { start: 7, end: 9, text: "Heavy contact! That late challenge changes the tempo" },
    { audioPeaks: [{ time: 8, energyScore: 0.88 }], sceneChanges: [{ time: 8.1, confidence: 0.76 }] },
  );
  assert.equal(foulReasons.includes("hard_foul"), true);
  assert.equal(foulReasons.includes("foul"), true);
  assert.equal(foulReasons.includes("goal"), false);
});

test("non-event goal context does not create goal evidence", () => {
  const reasons = reasonCodesForCaption(
    { start: 12, end: 14, text: "Replay the angle from behind the goal" },
    { audioPeaks: [], sceneChanges: [] },
  );
  assert.equal(reasons.includes("goal"), false);
  assert.equal(reasons.includes("replay_worthy_moment"), true);
});

test("transcription provider keeps mock fallback and language normalization", async () => {
  const provider = chooseTranscriptionProvider({ forceMock: true });
  assert.equal(provider instanceof MockTranscriptionProvider, true);
  assert.equal(normalizeLanguageCode("Ελληνικά"), "el");
  const result = await provider.transcribe({ metadata, preset: "hype", language: "English" });
  assert.equal(result.provider, "mock");
  assert.equal(result.language, "en");
  assert.ok(result.segments.length > 0);
});

test("OpenAI transcription adapter returns safe structured failures", async () => {
  const provider = new OpenAITranscriptionProvider({
    apiKey: "sk-secret-that-must-not-leak",
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    retries: 0,
    timeoutMs: 50,
  });
  await assert.rejects(
    () => provider.transcribe({ audioPath: __filename, language: "English" }),
    (error) => error.code === "TRANSCRIPTION_FAILED" && !String(error.message).includes("sk-secret"),
  );
});

test("analysis health reports deterministic readiness", () => {
  const health = analysisHealth();
  assert.equal(health.ready, true);
  assert.equal(health.features.includes("highlight_ranking"), true);
  assert.equal(health.features.includes("football_highlight_taxonomy"), true);
  assert.equal(health.features.includes("false_goal_guard"), true);
  assert.equal(health.features.includes("vision_safe_action_signals"), true);
});
