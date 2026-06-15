const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analysisHealth,
  createCandidateEditPlans,
  detectHighlights,
  extractMediaSignals,
  reasonCodesForCaption,
} = require("../server/analysis.cjs");
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

test("highlight detection ranks goal-like audio peak moments first", () => {
  const signals = {
    durationSeconds: 22,
    hasAudio: true,
    audioPeaks: [{ time: 8.5, energyScore: 0.92, source: "fixture" }],
    sceneChanges: [{ time: 8.4, confidence: 0.81, source: "fixture" }],
  };
  const result = detectHighlights({ transcript, signals, preset: "hype" });
  assert.equal(result.fallback, false);
  assert.equal(result.moments[0].reasonCodes.includes("goal_like_phrase"), true);
  assert.equal(result.moments[0].reasonCodes.includes("audio_peak"), true);
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
  assert.equal(plans[0].reasonCodes.includes("goal_like_phrase"), true);
});

test("reason code extraction recognizes football and replay signals", () => {
  const reasons = reasonCodesForCaption(
    { start: 5, end: 7, text: "Replay the GOAL angle and the crowd roar!" },
    {
      audioPeaks: [{ time: 6, energyScore: 0.9 }],
      sceneChanges: [{ time: 6.2, confidence: 0.8 }],
    },
  );
  assert.equal(reasons.includes("goal_like_phrase"), true);
  assert.equal(reasons.includes("replay_marker"), true);
  assert.equal(reasons.includes("crowd_reaction"), true);
  assert.equal(reasons.includes("audio_peak"), true);
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
});
