const { existsSync, statSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { RENDERER_SCRIPT } = require("../../../adapters/narrated-renderer-adapter.cjs");
const { probeFasterWhisperRuntime } = require("../../../adapters/faster-whisper-adapter.cjs");
const { CONFIG } = require("../../../config.cjs");

function commandAvailable(command) { const result = spawnSync(command, ["-version"], { stdio: "ignore", timeout: 5000 }); return result.status === 0; }

function pilotReadiness(input = {}, dependencies = {}) {
  const ffmpeg = (dependencies.commandAvailable || commandAvailable)(CONFIG.ffmpegBin);
  const ffprobe = (dependencies.commandAvailable || commandAvailable)(CONFIG.ffprobeBin);
  const renderer = existsSync(RENDERER_SCRIPT);
  const aligner = Boolean((dependencies.probeAlignerRuntime || probeFasterWhisperRuntime)(dependencies.alignerEnv || process.env).available);
  const managedStorage = [CONFIG.dataDir, CONFIG.tmpDir, CONFIG.artifactDir].every((path) => existsSync(path) && statSync(path).isDirectory());
  const fixtureValid = input.fixtureValid === true;
  const narrationAvailable = Boolean(input.audioPath && existsSync(input.audioPath));
  const rightsConfirmed = input.rightsConfirmed === true;
  const previewCapable = ffmpeg && ffprobe && renderer && aligner && narrationAvailable && rightsConfirmed && fixtureValid && managedStorage;
  const technicalFinalCapable = previewCapable;
  const blockingReasons = [];
  const nextActions = [];
  if (!ffmpeg) { blockingReasons.push("ffmpeg_unavailable"); nextActions.push("install-or-configure-ffmpeg"); }
  if (!ffprobe) { blockingReasons.push("ffprobe_unavailable"); nextActions.push("install-or-configure-ffprobe"); }
  if (!renderer) { blockingReasons.push("renderer_unavailable"); nextActions.push("restore-narrated-renderer"); }
  if (!aligner) { blockingReasons.push("aligner_unavailable"); nextActions.push("install-local-aligner-model"); }
  if (!managedStorage) { blockingReasons.push("managed_storage_unavailable"); nextActions.push("initialize-managed-storage"); }
  if (!fixtureValid) { blockingReasons.push("fixture_invalid"); nextActions.push("fix-pilot-fixture"); }
  if (!narrationAvailable) { blockingReasons.push("authorized_narration_missing"); nextActions.push("provide-authorized-wav"); }
  if (!rightsConfirmed) { blockingReasons.push("rights_not_confirmed"); nextActions.push("confirm-commercial-use-rights"); }
  const reportOnly = input.reportOnly === true;
  return { status: reportOnly ? "report_only" : blockingReasons.length ? "blocked" : "ready", environmentReady: ffmpeg && ffprobe && renderer && managedStorage, ffmpeg, ffprobe, renderer, aligner, managedStorage, fixtureValid, narrationAvailable, rightsConfirmed, previewCapable, technicalFinalCapable, blockingReasons, nextActions };
}

module.exports = { commandAvailable, pilotReadiness };
