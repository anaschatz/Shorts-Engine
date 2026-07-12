const { createHash } = require("node:crypto");
const { mkdtempSync, readFileSync, rmSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { CONFIG } = require("../../../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { ffprobeJson } = require("../../../media.cjs");
const { runFfmpeg } = require("../../../render.cjs");
const { contentHash } = require("../contracts.cjs");
const { CONTACT_SHEET_PROFILE, EVIDENCE_PROFILE_VERSION, normalizeContactSheet } = require("./contract.cjs");

const CONTACT_SHEET_RENDERER_VERSION = "ffmpeg_contact_sheet_v1";
const CONTACT_SHEET_WIDTH = 1080;
const CONTACT_SHEET_HEIGHT = 1280;
const CONTACT_SHEET_FRAME_COUNT = 6;
const MAX_CONTACT_SHEET_BYTES = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }

function contactSheetFrames(totalFrames, fps = 30) {
  const total = Number(totalFrames);
  const rate = Number(fps);
  if (!Number.isInteger(total) || total < 12 || !Number.isFinite(rate) || rate <= 0) throw new AppError("CONTACT_SHEET_INVALID", SAFE_MESSAGES.CONTACT_SHEET_INVALID, 409, { field: "timeline" });
  const frames = Array.from({ length: CONTACT_SHEET_FRAME_COUNT }, (_, index) => Math.min(total - 2, Math.max(0, Math.floor(((index * 2 + 1) * total) / 12))));
  if (new Set(frames).size !== CONTACT_SHEET_FRAME_COUNT) throw new AppError("CONTACT_SHEET_INVALID", SAFE_MESSAGES.CONTACT_SHEET_INVALID, 409, { field: "timestamps" });
  return { frames, timestampsSeconds: frames.map((frame) => Number((frame / rate).toFixed(4))) };
}

function assertPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength <= PNG_SIGNATURE.length || buffer.byteLength > MAX_CONTACT_SHEET_BYTES || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new AppError("CONTACT_SHEET_INVALID", SAFE_MESSAGES.CONTACT_SHEET_INVALID, 409, { field: "png" });
  }
}

async function generateContactSheet(input = {}, dependencies = {}) {
  const { outputPath, timeline, bindings, artifactStore, artifactRepository, projectId, jobId, signal } = input;
  if (!outputPath || !timeline || !artifactStore || !artifactRepository) throw new AppError("CONTACT_SHEET_GENERATION_FAILED", SAFE_MESSAGES.CONTACT_SHEET_GENERATION_FAILED, 409);
  if (signal && signal.aborted) throw new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 499);
  const timing = contactSheetFrames(timeline.totalFrames, timeline.fps);
  const tempRoot = mkdtempSync(join(CONFIG.tmpDir, "contact-sheet-"));
  const output = join(tempRoot, "contact-sheet.png");
  try {
    const select = timing.frames.map((frame) => `eq(n\\,${frame})`).join("+");
    const filter = `select='${select}',scale=360:640:flags=lanczos,tile=3x2`;
    const runner = dependencies.ffmpegRunner || runFfmpeg;
    await runner(["-y", "-hide_banner", "-nostats", "-i", outputPath, "-vf", filter, "-frames:v", "1", "-vsync", "0", output], { signal, timeoutMs: input.timeoutMs });
    const size = statSync(output).size;
    if (!size || size > MAX_CONTACT_SHEET_BYTES) throw new AppError("CONTACT_SHEET_INVALID", SAFE_MESSAGES.CONTACT_SHEET_INVALID, 409, { field: "size" });
    const buffer = readFileSync(output);
    assertPng(buffer);
    const probe = await (dependencies.ffprobeJson || ffprobeJson)(output);
    const video = Array.isArray(probe && probe.streams) ? probe.streams.find((stream) => stream.codec_type === "video") : null;
    if (!video || Number(video.width) !== CONTACT_SHEET_WIDTH || Number(video.height) !== CONTACT_SHEET_HEIGHT) throw new AppError("CONTACT_SHEET_INVALID", SAFE_MESSAGES.CONTACT_SHEET_INVALID, 409, { field: "dimensions" });
    const checksumSha256 = sha256(buffer);
    const identity = contentHash({ projectId, projectRevision: bindings.projectRevision, outputHash: bindings.outputHash, checksumSha256, timestampsSeconds: timing.timestampsSeconds, rendererVersion: CONTACT_SHEET_RENDERER_VERSION });
    const id = `art_${identity.slice(0, 40)}`;
    let artifact = artifactRepository.get(id);
    if (!artifact) {
      artifact = artifactStore.writeBuffer({ id, type: "contact_sheet", ownerProjectId: projectId, ownerJobId: jobId, storageKey: `content/${projectId}/contact_sheet/${identity}.png`, contentType: "image/png", checksumSha256, buffer, status: "available" });
      artifactRepository.create(artifact);
    } else if (artifact.type !== "contact_sheet" || artifact.ownerProjectId !== projectId || artifact.checksumSha256 !== checksumSha256 || artifact.status !== "available") {
      throw new AppError("CONTACT_SHEET_INVALID", SAFE_MESSAGES.CONTACT_SHEET_INVALID, 409, { field: "artifact" });
    }
    const descriptor = normalizeContactSheet({ schemaVersion: 1, profile: CONTACT_SHEET_PROFILE, profileVersion: EVIDENCE_PROFILE_VERSION, bindings, artifactId: artifact.id, checksumSha256, width: CONTACT_SHEET_WIDTH, height: CONTACT_SHEET_HEIGHT, frameCount: CONTACT_SHEET_FRAME_COUNT, timestampsSeconds: timing.timestampsSeconds, rendererVersion: CONTACT_SHEET_RENDERER_VERSION });
    return { artifact, descriptor };
  } catch (error) {
    if (["JOB_CANCELLED", "CONTACT_SHEET_INVALID"].includes(error && error.code)) throw error;
    throw new AppError("CONTACT_SHEET_GENERATION_FAILED", SAFE_MESSAGES.CONTACT_SHEET_GENERATION_FAILED, 409);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

module.exports = { CONTACT_SHEET_FRAME_COUNT, CONTACT_SHEET_HEIGHT, CONTACT_SHEET_RENDERER_VERSION, CONTACT_SHEET_WIDTH, assertPng, contactSheetFrames, generateContactSheet };
