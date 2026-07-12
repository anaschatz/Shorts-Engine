const { statSync } = require("node:fs");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { ffprobeJson } = require("../../../media.cjs");
const { runFfmpeg } = require("../../../render.cjs");
const { gate } = require("./contract.cjs");

const DETECTOR_PROFILE = Object.freeze({ blackRatioMax: 0.35, longestBlackSecondsMax: 2, frozenRatioMax: 0.6, longestFreezeSecondsMax: 6, silentRatioMax: 0.2, longestSilenceSecondsMax: 2 });

function durations(text, label) {
  const pattern = new RegExp(`${label}(?:_duration)?\\s*[:=]\\s*([0-9]+(?:\\.[0-9]+)?)`, "g");
  return [...String(text || "").matchAll(pattern)].map((match) => Number(match[1])).filter((value) => Number.isFinite(value) && value >= 0).slice(0, 200);
}
function metric(values, total) {
  const sum = values.reduce((value, item) => value + item, 0);
  return { ratio: Number(Math.min(1, sum / total).toFixed(4)), longestSeconds: Number(Math.max(0, ...values).toFixed(4)) };
}
function parseDetectorOutput(stderr, durationSeconds) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) throw new AppError("RENDERED_VIDEO_QA_FAILED", SAFE_MESSAGES.RENDERED_VIDEO_QA_FAILED, 409);
  return { black: metric(durations(stderr, "black_duration"), duration), freeze: metric(durations(stderr, "freeze_duration"), duration), silence: metric(durations(stderr, "silence_duration"), duration) };
}
function frameRate(stream) {
  const parts = String(stream && (stream.avg_frame_rate || stream.r_frame_rate) || "0/1").split("/").map(Number);
  return parts[1] ? parts[0] / parts[1] : 0;
}

async function analyzeRenderedVideo({ outputPath, timeline, renderProfile, signal, ffprobeImpl = ffprobeJson, ffmpegRunner = runFfmpeg }) {
  if (signal && signal.aborted) throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409);
  let size = 0;
  try { size = statSync(outputPath).size; } catch { throw new AppError("RENDERED_VIDEO_QA_FAILED", SAFE_MESSAGES.RENDERED_VIDEO_QA_FAILED, 409); }
  const probe = await ffprobeImpl(outputPath);
  const streams = Array.isArray(probe && probe.streams) ? probe.streams : [];
  const videos = streams.filter((stream) => stream.codec_type === "video");
  const audios = streams.filter((stream) => stream.codec_type === "audio");
  const video = videos[0] || {};
  const audio = audios[0] || {};
  const durationSeconds = Number(probe && probe.format && probe.format.duration);
  let detector;
  try {
    const result = await ffmpegRunner(["-hide_banner", "-nostats", "-i", outputPath, "-vf", "blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-50dB:d=2", "-af", "silencedetect=n=-50dB:d=1", "-f", "null", "-"], { signal });
    detector = parseDetectorOutput(result && result.stderr, durationSeconds);
  } catch (error) {
    if (error && error.code === "JOB_CANCELLED") throw error;
    throw new AppError("RENDERED_VIDEO_QA_FAILED", SAFE_MESSAGES.RENDERED_VIDEO_QA_FAILED, 409);
  }
  return { size, durationSeconds, videoCount: videos.length, audioCount: audios.length, width: Number(video.width || 0), height: Number(video.height || 0), fps: frameRate(video), videoCodec: video.codec_name || null, pixelFormat: video.pix_fmt || null, audioCodec: audio.codec_name || null, audioSampleRate: Number(audio.sample_rate || 0), detector };
}

function runRenderedVideoQa({ analysis, timeline, renderProfile }) {
  const expected = renderProfile === "final" ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
  const durationMatch = Number.isFinite(analysis.durationSeconds) && Math.abs(analysis.durationSeconds - timeline.totalFrames / timeline.fps) <= Math.max(0.15, 2 / timeline.fps);
  const blackPassed = analysis.detector.black.ratio <= DETECTOR_PROFILE.blackRatioMax && analysis.detector.black.longestSeconds <= DETECTOR_PROFILE.longestBlackSecondsMax;
  const freezePassed = analysis.detector.freeze.ratio <= DETECTOR_PROFILE.frozenRatioMax && analysis.detector.freeze.longestSeconds <= DETECTOR_PROFILE.longestFreezeSecondsMax;
  const silencePassed = analysis.detector.silence.ratio <= DETECTOR_PROFILE.silentRatioMax && analysis.detector.silence.longestSeconds <= DETECTOR_PROFILE.longestSilenceSecondsMax;
  return [
    gate("VIDEO_FILE_READABLE", "rendered_video", analysis.size > 0, { expected: true, actual: analysis.size > 0 }),
    gate("VIDEO_CONTAINER_VALID", "rendered_video", analysis.videoCount === 1 && analysis.audioCount === 1, { expected: 2, actual: analysis.videoCount + analysis.audioCount }),
    gate("VIDEO_DIMENSIONS_VALID", "rendered_video", analysis.width === expected.width && analysis.height === expected.height, { expected: `${expected.width}x${expected.height}`, actual: `${analysis.width}x${analysis.height}` }),
    gate("VIDEO_FPS_VALID", "rendered_video", Math.abs(analysis.fps - 30) <= 0.01, { expected: 30, actual: analysis.fps }),
    gate("VIDEO_CODEC_VALID", "rendered_video", analysis.videoCodec === "h264" && analysis.audioCodec === "aac", { expected: "h264+aac", actual: `${analysis.videoCodec || "missing"}+${analysis.audioCodec || "missing"}` }),
    gate("VIDEO_PIXEL_FORMAT_VALID", "rendered_video", analysis.pixelFormat === "yuv420p", { expected: "yuv420p", actual: analysis.pixelFormat || "missing" }),
    gate("VIDEO_DURATION_MATCH", "rendered_video", durationMatch, { expected: timeline.totalFrames / timeline.fps, actual: analysis.durationSeconds }),
    gate("VIDEO_BLACK_OUTPUT_ABSENT", "rendered_video", blackPassed, { ratio: analysis.detector.black.ratio, seconds: analysis.detector.black.longestSeconds }),
    gate("VIDEO_EXCESSIVE_FREEZE_ABSENT", "rendered_video", freezePassed, { ratio: analysis.detector.freeze.ratio, seconds: analysis.detector.freeze.longestSeconds }),
    gate("VIDEO_AUDIO_NOT_SILENT", "rendered_video", silencePassed, { ratio: analysis.detector.silence.ratio, seconds: analysis.detector.silence.longestSeconds }),
  ];
}

module.exports = { DETECTOR_PROFILE, analyzeRenderedVideo, parseDetectorOutput, runRenderedVideoQa };
