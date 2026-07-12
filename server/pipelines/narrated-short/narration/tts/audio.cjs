const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync, statSync } = require("node:fs");
const { CONFIG } = require("../../../../config.cjs");
const { AppError } = require("../../../../errors.cjs");
const { ffprobeJson, sha256 } = require("../../../../media.cjs");

function invalid(field = "audio") { throw new AppError("TTS_AUDIO_INVALID", "AI narration audio is invalid.", 415, { field }); }
function normalizeWithFfmpeg(source, target, dependencies = {}) {
  const run = dependencies.spawnSync || spawnSync; const result = run(CONFIG.ffmpegBin, ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", target], { encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 });
  if (!result || result.status !== 0) invalid("ffmpeg");
}
async function validateNormalizedWav(path, dependencies = {}) {
  if (!existsSync(path) || statSync(path).size <= 44) invalid();
  let info; try { info = await (dependencies.ffprobeJson || ffprobeJson)(path); } catch { invalid("ffprobe"); }
  const streams = (info.streams || []).filter((value) => value.codec_type === "audio"); const stream = streams[0]; const duration = Number(info.format && info.format.duration || stream && stream.duration);
  if (streams.length !== 1 || !stream || stream.codec_name !== "pcm_s16le" || Number(stream.sample_rate) !== 48000 || Number(stream.channels) !== 1 || !Number.isFinite(duration) || duration <= 0 || duration > 120) invalid();
  return { container: "wav", codec: "pcm_s16le", sampleRate: 48000, channels: 1, durationSeconds: Number(duration.toFixed(4)), bytes: statSync(path).size, sha256: sha256(readFileSync(path)), validated: true };
}
module.exports = { normalizeWithFfmpeg, validateNormalizedWav };
