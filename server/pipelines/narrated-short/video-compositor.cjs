const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { runFfmpeg } = require("../../render.cjs");
const { ffprobeJson } = require("../../media.cjs");
const { AppError, SAFE_MESSAGES } = require("../../errors.cjs");
const { firstPassFilter, parseLoudnormMeasurement, secondPassFilter } = require("./audio-normalization.cjs");

const NARRATED_COMPOSITOR_VERSION = "narrated_compositor_v2";

function concatPath(value) {
  return `file '${resolve(value).replace(/'/g, "'\\''")}'`;
}

function validateManifest(timeline, manifest) {
  if (!timeline || !manifest || manifest.timelineHash !== timeline.contentHash) {
    throw new AppError("TIMELINE_INVALID", "Keyframes do not match the compiled timeline.", 409);
  }
  const frames = [...(Array.isArray(manifest.frames) ? manifest.frames : [])]
    .sort((a, b) => a.globalFrame - b.globalFrame || String(a.fileName).localeCompare(String(b.fileName)));
  if (!frames.length || frames.some((frame) => !Number.isInteger(frame.globalFrame) || !frame.outputPath)) {
    throw new AppError("TIMELINE_INVALID", SAFE_MESSAGES.VALIDATION_ERROR, 409);
  }
  return frames;
}

function filterPath(value) {
  return resolve(value).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function validateComposedPreview(probe, timeline, expectAudio) {
  const streams = Array.isArray(probe && probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe && probe.format && probe.format.duration);
  const expectedDuration = timeline.totalFrames / timeline.fps;
  const rateParts = String(video && (video.avg_frame_rate || video.r_frame_rate) || "0/1").split("/").map(Number);
  const frameRate = rateParts.length === 2 && rateParts[1] ? rateParts[0] / rateParts[1] : 0;
  if (!video || video.codec_name !== "h264" || Number(video.width) !== timeline.width || Number(video.height) !== timeline.height || Math.abs(frameRate - timeline.fps) > 0.01 || !Number.isFinite(duration) || Math.abs(duration - expectedDuration) > Math.max(0.15, 2 / timeline.fps)) {
    throw new AppError("NARRATED_COMPOSITION_FAILED", SAFE_MESSAGES.NARRATED_COMPOSITION_FAILED, 409);
  }
  if (expectAudio && (!audio || audio.codec_name !== "aac" || Number(audio.sample_rate) !== 48000)) throw new AppError("NARRATED_COMPOSITION_FAILED", SAFE_MESSAGES.NARRATED_COMPOSITION_FAILED, 409);
  if (!expectAudio && audio) throw new AppError("NARRATED_COMPOSITION_FAILED", SAFE_MESSAGES.NARRATED_COMPOSITION_FAILED, 409);
  return { durationSeconds: Number(duration.toFixed(4)), videoCodec: video.codec_name || null, audioCodec: audio ? audio.codec_name : null, audioSampleRate: audio ? Number(audio.sample_rate) : null };
}

async function composeNarratedPreview(input = {}) {
  const { timeline, keyframeManifest, outputPath, audioPath = null, assPath = null, font = null, signal } = input;
  if (!outputPath) throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "outputPath" });
  if (Boolean(audioPath) !== Boolean(assPath)) throw new AppError("CAPTION_ALIGNMENT_REQUIRED", SAFE_MESSAGES.CAPTION_ALIGNMENT_REQUIRED, 409);
  if (audioPath && (!font || !font.fontsDir)) throw new AppError("CAPTION_FONT_UNAVAILABLE", SAFE_MESSAGES.CAPTION_FONT_UNAVAILABLE, 409);
  const frames = validateManifest(timeline, keyframeManifest);
  const runner = input.ffmpegRunner || runFfmpeg;
  const workDir = mkdtempSync(join(dirname(resolve(outputPath)), ".narrated-concat-"));
  const concatFile = join(workDir, "keyframes.ffconcat");
  const lines = ["ffconcat version 1.0"];
  frames.forEach((frame, index) => {
    const nextFrame = index + 1 < frames.length ? frames[index + 1].globalFrame : timeline.totalFrames;
    const durationFrames = Math.max(1, nextFrame - frame.globalFrame);
    lines.push(concatPath(frame.outputPath));
    lines.push(`duration ${(durationFrames / timeline.fps).toFixed(6)}`);
  });
  lines.push(concatPath(frames[frames.length - 1].outputPath));
  writeFileSync(concatFile, `${lines.join("\n")}\n`, "utf8");
  let loudness = null;
  if (audioPath) {
    try {
      const measured = await runner(["-hide_banner", "-nostats", "-i", resolve(audioPath), "-af", firstPassFilter(), "-f", "null", "-"], { signal, timeoutMs: input.timeoutMs });
      loudness = parseLoudnormMeasurement(measured && measured.stderr);
    } catch (error) {
      if (error && error.code === "JOB_CANCELLED") throw error;
      throw new AppError("AUDIO_NORMALIZATION_FAILED", SAFE_MESSAGES.AUDIO_NORMALIZATION_FAILED, 409);
    }
  }
  const args = ["-y", "-f", "concat", "-safe", "0", "-i", concatFile];
  if (audioPath) args.push("-i", resolve(audioPath));
  const videoFilter = [`fps=${timeline.fps}`, `scale=${timeline.width}:${timeline.height}:flags=lanczos`];
  if (assPath) videoFilter.push(`ass=filename='${filterPath(assPath)}':fontsdir='${filterPath(font.fontsDir)}'`);
  videoFilter.push("format=yuv420p");
  args.push(
    "-vf", videoFilter.join(","),
    "-c:v", "libx264", "-preset", input.renderProfile === "final" ? "medium" : "veryfast",
    "-crf", input.renderProfile === "final" ? "18" : "22",
    "-r", String(timeline.fps),
  );
  if (audioPath) args.push("-map", "0:v:0", "-map", "1:a:0", "-af", secondPassFilter(loudness), "-c:a", "aac", "-ar", "48000", "-b:a", "192k", "-shortest");
  else args.push("-an", "-t", (timeline.totalFrames / timeline.fps).toFixed(6));
  args.push("-movflags", "+faststart", resolve(outputPath));
  try {
    await runner(args, { signal, timeoutMs: input.timeoutMs });
    const probe = await (input.ffprobeJson || ffprobeJson)(resolve(outputPath));
    const technical = validateComposedPreview(probe, timeline, Boolean(audioPath));
    return {
      schemaVersion: 1,
      outputPath: resolve(outputPath),
      width: timeline.width,
      height: timeline.height,
      fps: timeline.fps,
      totalFrames: timeline.totalFrames,
      durationSeconds: technical.durationSeconds,
      audioIncluded: Boolean(audioPath),
      captionsIncluded: Boolean(assPath),
      captionsBurned: Boolean(assPath),
      audioNormalized: Boolean(audioPath),
      audioCodec: technical.audioCodec,
      audioSampleRate: technical.audioSampleRate,
      renderProfile: input.renderProfile === "final" ? "final" : "preview",
      timelineHash: timeline.contentHash,
      keyframeCount: frames.length,
      loudness,
    };
  } catch (error) {
    if (["JOB_CANCELLED", "AUDIO_NORMALIZATION_FAILED", "NARRATED_COMPOSITION_FAILED"].includes(error && error.code)) throw error;
    throw new AppError("NARRATED_COMPOSITION_FAILED", SAFE_MESSAGES.NARRATED_COMPOSITION_FAILED, 409);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { NARRATED_COMPOSITOR_VERSION, composeNarratedPreview, filterPath, validateComposedPreview, validateKeyframeManifest: validateManifest };
