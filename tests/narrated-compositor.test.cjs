const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { composeNarratedPreview, composeNarratedVisualMaster } = require("../server/pipelines/narrated-short/video-compositor.cjs");

test("narrated compositor builds a bounded deterministic FFmpeg invocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "narrated-compositor-"));
  const calls = [];
  try {
    const timeline = { contentHash: "a".repeat(64), fps: 30, width: 720, height: 1280, totalFrames: 90 };
    const manifest = {
      timelineHash: timeline.contentHash,
      frames: [
        { globalFrame: 0, outputPath: join(dir, "a.png"), fileName: "a.png" },
        { globalFrame: 30, outputPath: join(dir, "b.png"), fileName: "b.png" },
      ],
    };
    const result = await composeNarratedPreview({
      timeline,
      keyframeManifest: manifest,
      outputPath: join(dir, "preview.mp4"),
      ffmpegRunner: async (args, options) => calls.push({ args, options }),
      ffprobeJson: async () => ({ streams: [{ codec_type: "video", codec_name: "h264", width: 720, height: 1280, avg_frame_rate: "30/1" }], format: { duration: "3.000" } }),
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 6), ["-y", "-f", "concat", "-safe", "0", "-i"]);
    assert.ok(calls[0].args.includes("fps=30,scale=720:1280:flags=lanczos,format=yuv420p"));
    assert.ok(calls[0].args.includes("-an"));
    assert.equal(result.durationSeconds, 3);
    assert.equal(result.audioIncluded, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("narrated compositor burns ASS and applies measured two-pass loudnorm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "narrated-compositor-audio-"));
  const calls = [];
  const loudness = JSON.stringify({ input_i: "-22.10", input_tp: "-4.20", input_lra: "3.10", input_thresh: "-32.20", output_i: "-16.02", output_tp: "-1.60", output_lra: "3.00", target_offset: "0.02" });
  try {
    const timeline = { contentHash: "c".repeat(64), fps: 30, width: 720, height: 1280, totalFrames: 90 };
    const result = await composeNarratedPreview({
      timeline,
      keyframeManifest: { timelineHash: timeline.contentHash, frames: [{ globalFrame: 0, outputPath: join(dir, "a.png"), fileName: "a.png" }] },
      outputPath: join(dir, "preview.mp4"), audioPath: join(dir, "voice.wav"), assPath: join(dir, "captions.ass"), font: { fontsDir: dir },
      ffmpegRunner: async (args, options) => { calls.push({ args, options }); return { stderr: calls.length === 1 ? loudness : "" }; },
      ffprobeJson: async () => ({ streams: [{ codec_type: "video", codec_name: "h264", width: 720, height: 1280, avg_frame_rate: "30/1" }, { codec_type: "audio", codec_name: "aac", sample_rate: "48000" }], format: { duration: "3.000" } }),
    });
    assert.equal(calls.length, 2);
    assert.ok(calls[0].args.includes("-f") && calls[0].args.includes("null"));
    assert.match(calls[1].args[calls[1].args.indexOf("-vf") + 1], /ass=filename=/);
    assert.match(calls[1].args[calls[1].args.indexOf("-af") + 1], /measured_I=-22.1/);
    assert.equal(result.audioIncluded, true);
    assert.equal(result.captionsBurned, true);
    assert.equal(result.audioNormalized, true);
    assert.equal(result.audioSampleRate, 48000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("continuous visual-master compositor preserves animation and produces exact narrated output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "narrated-continuous-"));
  const calls = [];
  const loudness = JSON.stringify({ input_i: "-22.10", input_tp: "-4.20", input_lra: "3.10", input_thresh: "-32.20", output_i: "-16.02", output_tp: "-1.60", output_lra: "3.00", target_offset: "0.02" });
  try {
    const timeline = { contentHash: "f".repeat(64), fps: 30, width: 1080, height: 1920, totalFrames: 1031 };
    const result = await composeNarratedVisualMaster({
      timeline,
      visualMasterPath: join(dir, "visual-master.mp4"),
      outputPath: join(dir, "final.mp4"),
      audioPath: join(dir, "voice.wav"),
      assPath: join(dir, "captions.ass"),
      font: { fontsDir: dir },
      renderProfile: "final",
      ffmpegRunner: async (args, options) => { calls.push({ args, options }); return { stderr: calls.length === 1 ? loudness : "" }; },
      ffprobeJson: async () => ({ streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/1" }, { codec_type: "audio", codec_name: "aac", sample_rate: "48000" }], format: { duration: (1031 / 30).toFixed(6) } }),
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].args.slice(0, 3), ["-y", "-i", join(dir, "visual-master.mp4")]);
    assert.equal(calls[1].args[calls[1].args.indexOf("-t") + 1], (1031 / 30).toFixed(6));
    assert.match(calls[1].args[calls[1].args.indexOf("-vf") + 1], /^fps=30,scale=1080:1920:flags=lanczos,ass=/);
    assert.equal(result.visualMasterInput, true);
    assert.equal(result.audioIncluded, true);
    assert.equal(result.captionsBurned, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("narrated compositor rejects keyframes from another timeline", async () => {
  await assert.rejects(() => composeNarratedPreview({
    timeline: { contentHash: "a".repeat(64) },
    keyframeManifest: { timelineHash: "b".repeat(64), frames: [] },
    outputPath: "/tmp/preview.mp4",
    ffmpegRunner: async () => {},
  }), { code: "TIMELINE_INVALID" });
});

test("narration normalization timeout and cancellation stay safe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "narrated-compositor-failure-"));
  const timeline = { contentHash: "e".repeat(64), fps: 30, width: 720, height: 1280, totalFrames: 90 };
  const base = { timeline, keyframeManifest: { timelineHash: timeline.contentHash, frames: [{ globalFrame: 0, outputPath: join(dir, "a.png"), fileName: "a.png" }] }, outputPath: join(dir, "preview.mp4"), audioPath: "/managed/voice.wav", assPath: "/managed/captions.ass", font: { fontsDir: "/managed" } };
  try {
    await assert.rejects(() => composeNarratedPreview({ ...base, ffmpegRunner: async () => { throw new Error("/private/raw stderr"); } }), (error) => error.code === "AUDIO_NORMALIZATION_FAILED" && !JSON.stringify(error).includes("/private"));
    await assert.rejects(() => composeNarratedPreview({ ...base, ffmpegRunner: async () => { const error = new Error("cancel"); error.code = "JOB_CANCELLED"; throw error; } }), (error) => error.code === "JOB_CANCELLED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
