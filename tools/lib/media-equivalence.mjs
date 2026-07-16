import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export const MEDIA_EQUIVALENCE_THRESHOLDS = Object.freeze({
  averagePsnrDb: 60,
  minimumPsnrDb: 50,
  ssim: 0.9998,
});

const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 120_000;

function runProcess(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("media_equivalence_process_timeout"));
    }, PROCESS_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(new Error("media_equivalence_output_too_large"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(new Error("media_equivalence_output_too_large"));
      }
    });
    child.on("error", () => finish(new Error("media_equivalence_process_failed")));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) finish(new Error("media_equivalence_process_failed"));
      else finish(null, { stdout, stderr });
    });
  });
}

function metric(value) {
  if (String(value).toLowerCase() === "inf") return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("media_equivalence_metric_invalid");
  return parsed;
}

export function parsePsnrSummary(output) {
  const match = String(output).match(/PSNR\s+y:(?:inf|[-+0-9.]+)\s+u:(?:inf|[-+0-9.]+)\s+v:(?:inf|[-+0-9.]+)\s+average:(inf|[-+0-9.]+)\s+min:(inf|[-+0-9.]+)/i);
  if (!match) throw new Error("media_equivalence_psnr_missing");
  return Object.freeze({ averageDb: metric(match[1]), minimumDb: metric(match[2]) });
}

export function parseSsimSummary(output) {
  const match = String(output).match(/SSIM\s+Y:(?:[-+0-9.]+)\s+\([^)]*\)\s+U:(?:[-+0-9.]+)\s+\([^)]*\)\s+V:(?:[-+0-9.]+)\s+\([^)]*\)\s+All:([-+0-9.]+)/i);
  if (!match) throw new Error("media_equivalence_ssim_missing");
  return metric(match[1]);
}

function parseStreamHash(output) {
  const match = String(output).match(/SHA256=([a-f0-9]{64})/i);
  if (!match) throw new Error("media_equivalence_audio_hash_missing");
  return match[1].toLowerCase();
}

function normalizeProbe(input) {
  if (!input || !Array.isArray(input.streams) || !input.format) throw new Error("media_equivalence_probe_invalid");
  return Object.freeze({
    streams: input.streams.map((stream) => ({
      index: stream.index,
      codecType: stream.codec_type,
      codecName: stream.codec_name,
      width: stream.width ?? null,
      height: stream.height ?? null,
      pixelFormat: stream.pix_fmt ?? null,
      frameRate: stream.r_frame_rate ?? null,
      averageFrameRate: stream.avg_frame_rate ?? null,
      timeBase: stream.time_base ?? null,
      startTime: stream.start_time ?? null,
      frameCount: stream.nb_frames ?? null,
      durationTimestamp: stream.duration_ts ?? null,
      duration: stream.duration ?? null,
      sampleRate: stream.sample_rate ?? null,
      channels: stream.channels ?? null,
      channelLayout: stream.channel_layout ?? null,
    })),
    startTime: input.format.start_time ?? null,
    duration: input.format.duration,
  });
}

async function probe(path) {
  const result = await runProcess("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=index,codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,time_base,start_time,nb_frames,duration_ts,duration,sample_rate,channels,channel_layout",
    "-show_entries", "format=start_time,duration",
    "-of", "json",
    path,
  ]);
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch { throw new Error("media_equivalence_probe_invalid"); }
  return normalizeProbe(parsed);
}

async function decodedTimelineHash(path) {
  const result = await runProcess("ffprobe", [
    "-v", "error",
    "-show_frames",
    "-show_entries", "frame=media_type,stream_index,pts,best_effort_timestamp,duration",
    "-of", "json",
    path,
  ]);
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch { throw new Error("media_equivalence_timeline_invalid"); }
  if (!Array.isArray(parsed.frames) || !parsed.frames.length) throw new Error("media_equivalence_timeline_invalid");
  const timeline = parsed.frames.map((frame) => {
    const mediaType = String(frame.media_type || "");
    const streamIndex = Number(frame.stream_index);
    const pts = String(frame.pts ?? "");
    const bestEffortTimestamp = String(frame.best_effort_timestamp ?? "");
    const duration = String(frame.duration ?? "");
    if (!["video", "audio"].includes(mediaType) || !Number.isInteger(streamIndex) || !/^-?\d+$/.test(pts) || !/^-?\d+$/.test(bestEffortTimestamp) || !/^\d+$/.test(duration)) throw new Error("media_equivalence_timeline_invalid");
    return [mediaType, streamIndex, pts, bestEffortTimestamp, duration];
  });
  return createHash("sha256").update(JSON.stringify(timeline)).digest("hex");
}

async function decodedAudioHash(path) {
  const result = await runProcess("ffmpeg", ["-hide_banner", "-v", "error", "-i", path, "-map", "0:a:0", "-f", "hash", "-hash", "sha256", "-"]);
  return parseStreamHash(result.stdout);
}

export function assessMediaEquivalence({ firstProbe, secondProbe, firstAudioHash, secondAudioHash, firstTimelineHash, secondTimelineHash, psnr, ssim }, thresholds = MEDIA_EQUIVALENCE_THRESHOLDS) {
  const metadataEqual = JSON.stringify(firstProbe) === JSON.stringify(secondProbe);
  const audioHashEqual = firstAudioHash === secondAudioHash;
  const timelineHashEqual = firstTimelineHash === secondTimelineHash;
  const psnrPassed = psnr.averageDb >= thresholds.averagePsnrDb && psnr.minimumDb >= thresholds.minimumPsnrDb;
  const ssimPassed = ssim >= thresholds.ssim;
  return Object.freeze({
    passed: metadataEqual && audioHashEqual && timelineHashEqual && psnrPassed && ssimPassed,
    metadataEqual,
    audioHashEqual,
    timelineHashEqual,
    psnrPassed,
    ssimPassed,
    firstAudioHash,
    secondAudioHash,
    firstTimelineHash,
    secondTimelineHash,
    psnr,
    ssim,
    thresholds,
  });
}

export async function compareMediaEquivalence(firstPath, secondPath) {
  const [firstProbe, secondProbe, firstAudioHash, secondAudioHash, firstTimelineHash, secondTimelineHash, psnrResult, ssimResult] = await Promise.all([
    probe(firstPath),
    probe(secondPath),
    decodedAudioHash(firstPath),
    decodedAudioHash(secondPath),
    decodedTimelineHash(firstPath),
    decodedTimelineHash(secondPath),
    runProcess("ffmpeg", ["-hide_banner", "-v", "info", "-i", firstPath, "-i", secondPath, "-lavfi", "[0:v:0][1:v:0]psnr", "-an", "-f", "null", "-"]),
    runProcess("ffmpeg", ["-hide_banner", "-v", "info", "-i", firstPath, "-i", secondPath, "-lavfi", "[0:v:0][1:v:0]ssim", "-an", "-f", "null", "-"]),
  ]);
  return assessMediaEquivalence({
    firstProbe,
    secondProbe,
    firstAudioHash,
    secondAudioHash,
    firstTimelineHash,
    secondTimelineHash,
    psnr: parsePsnrSummary(psnrResult.stderr),
    ssim: parseSsimSummary(ssimResult.stderr),
  });
}
