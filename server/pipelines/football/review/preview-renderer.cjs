const { stat } = require("node:fs/promises");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { ffprobeJson, sha256 } = require("../../../media.cjs");
const {
  renderShort,
  runFfmpeg,
} = require("../../../render.cjs");
const { normalizeCandidate } = require("./candidate-contract.cjs");

const PREVIEW_PROFILE = Object.freeze({
  width: 540,
  height: 960,
  fps: 24,
  videoBitrate: "1500k",
  audioBitrate: "96k",
});

function safeRenderError(error) {
  if (error instanceof AppError) return error;
  return new AppError(
    "RENDER_FAILED",
    SAFE_MESSAGES.RENDER_FAILED,
    500,
  );
}

function frameRate(value) {
  const [numerator, denominator] = String(value || "").split("/").map(Number);
  if (
    !Number.isFinite(numerator)
    || !Number.isFinite(denominator)
    || denominator <= 0
  ) {
    return 0;
  }
  return numerator / denominator;
}

function validatePreviewProbe(probe, expectedDurationSeconds) {
  const streams = Array.isArray(probe && probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const durationSeconds = Number(probe && probe.format && probe.format.duration);
  if (
    !video
    || video.codec_name !== "h264"
    || Number(video.width) !== PREVIEW_PROFILE.width
    || Number(video.height) !== PREVIEW_PROFILE.height
    || Math.abs(frameRate(video.avg_frame_rate) - PREVIEW_PROFILE.fps) > 0.05
    || !Number.isFinite(durationSeconds)
    || durationSeconds < 0.25
    || Math.abs(durationSeconds - expectedDurationSeconds) > 0.35
    || audio && audio.codec_name !== "aac"
  ) {
    throw new AppError(
      "RENDER_FAILED",
      SAFE_MESSAGES.RENDER_FAILED,
      500,
    );
  }
  return {
    width: Number(video.width),
    height: Number(video.height),
    fps: PREVIEW_PROFILE.fps,
    videoCodec: video.codec_name,
    audioCodec: audio ? audio.codec_name : null,
    durationSeconds: Number(durationSeconds.toFixed(3)),
  };
}

function previewPlan(candidate) {
  const plan = JSON.parse(JSON.stringify(candidate.editPlan));
  return {
    ...plan,
    sourceStart: candidate.sourceStart,
    sourceEnd: candidate.sourceEnd,
    totalDuration: candidate.durationSeconds,
    mode: "single_moment",
    segments: [],
    aspectRatio: "9:16",
    export: {
      width: PREVIEW_PROFILE.width,
      height: PREVIEW_PROFILE.height,
      fps: PREVIEW_PROFILE.fps,
    },
    renderProfile: "review_preview",
    captionsEnabled: true,
    framingMode: candidate.framing.mode,
    cropPlan: {
      ...(plan.cropPlan || {}),
      mode: candidate.framing.mode,
      confidence: candidate.framing.confidence,
      fallbackUsed: candidate.framing.fallbackUsed,
      reasonCodes: candidate.framing.reasonCodes,
    },
    endBeatText: candidate.purpose.label,
    reviewEditorial: {
      purpose: candidate.purpose,
      captions: candidate.captions,
      pacing: candidate.pacing,
    },
  };
}

async function renderFootballCandidatePreview(input = {}, dependencies = {}) {
  const candidate = normalizeCandidate(input.candidate, {
    projectId: input.candidate && input.candidate.projectId,
    sourceJobId: input.candidate && input.candidate.sourceJobId,
    sourceRevision: input.candidate && input.candidate.sourceRevision,
    sourceDurationSeconds: Math.max(
      Number(input.sourceDurationSeconds || 0),
      Number(input.candidate && input.candidate.sourceEnd || 0) + 1,
    ),
  });
  const render = dependencies.renderShort || renderShort;
  const probe = dependencies.ffprobeJson || ffprobeJson;
  try {
    await render({
      inputPath: input.sourcePath,
      outputPath: input.outputPath,
      subtitlesPath: input.subtitlesPath,
      plan: previewPlan(candidate),
      signal: input.signal,
      ffmpegRunner: dependencies.ffmpegRunner || runFfmpeg,
      enhancementConfig: { enabled: false },
    });
    const media = validatePreviewProbe(
      await probe(input.outputPath),
      candidate.durationSeconds,
    );
    const file = await stat(input.outputPath);
    const checksumSha256 = (dependencies.sha256 || sha256)(input.outputPath);
    return {
      manifest: {
        schemaVersion: 1,
        candidateId: candidate.id,
        sourceRevision: candidate.sourceRevision,
        planHash: candidate.planHash,
        checksumSha256,
        durationSeconds: media.durationSeconds,
        width: media.width,
        height: media.height,
        fps: media.fps,
        videoCodec: media.videoCodec,
        audioCodec: media.audioCodec,
        byteSize: file.size,
      },
      media,
      outputPath: input.outputPath,
    };
  } catch (error) {
    throw safeRenderError(error);
  }
}

module.exports = {
  PREVIEW_PROFILE,
  previewPlan,
  renderFootballCandidatePreview,
  validatePreviewProbe,
};
