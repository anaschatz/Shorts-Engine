const { existsSync, mkdirSync, readFileSync, statfsSync, unlinkSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { basename, isAbsolute, relative, resolve } = require("node:path");
const { createHash } = require("node:crypto");
const { CONFIG } = require("../../../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { ffprobeJson } = require("../../../media.cjs");
const { fasterWhisperConfig, fasterWhisperVersion, probeFasterWhisperRuntime, transcribeWithFasterWhisper } = require("../../../adapters/faster-whisper-adapter.cjs");
const { normalizeDraftBundle } = require("../contracts.cjs");
const { assertExactScript, providerWords, scriptWords } = require("../narration/alignment.cjs");
const { normalizeProbedMedia, validateWavCandidate } = require("../narration/upload.cjs");

const REPO_ROOT = resolve(__dirname, "../../../..");
const FIXTURE_ROOT = resolve(REPO_ROOT, "eval/narrated/dark-curiosity/fixtures");
const PREPARATION_PROFILE = "dark_curiosity_narration_preparation_v1";
const MODEL_ALLOWLIST = Object.freeze(["tiny", "base", "small"]);
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
function inside(root, candidate) { const path = relative(resolve(root), resolve(candidate)); return path === "" || (!path.startsWith("..") && !isAbsolute(path)); }
function fixtureAt(value) { const path = resolve(REPO_ROOT, String(value || "")); if (!inside(FIXTURE_ROOT, path) || !existsSync(path)) throw new AppError("PILOT_FIXTURE_UNSAFE", SAFE_MESSAGES.PILOT_FIXTURE_UNSAFE, 403); return path; }
function loadFixture(value) { const path = fixtureAt(value); const draft = normalizeDraftBundle(JSON.parse(readFileSync(path, "utf8"))); return { path, fixtureId: basename(path), draft }; }

function alignerDoctor(env = process.env, dependencies = {}) {
  const config = fasterWhisperConfig(env); const helperAvailable = existsSync(config.helperPath); let python;
  try { python = (dependencies.spawnSync || spawnSync)(config.pythonBin, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 8192 }); } catch { python = { status: null, error: { code: "RUNTIME_FAILED" } }; }
  const pythonAvailable = python.status === 0; const versionText = `${python.stdout || ""} ${python.stderr || ""}`.match(/Python\s+(\d+\.\d+\.\d+)/i); const pythonVersion = versionText ? versionText[1] : null; const versionParts = pythonVersion ? pythonVersion.split(".").map(Number) : []; const pythonSupported = versionParts[0] === 3 && versionParts[1] >= 9 && versionParts[1] < 13;
  let packageReady = false; let modelReady = false; let probeReason = null;
  if (config.mode !== "disabled" && pythonAvailable && helperAvailable) { try { const runtime = (dependencies.probeRuntime || probeFasterWhisperRuntime)(env, { refresh: true }); modelReady = runtime.available === true; probeReason = runtime.reason || null; packageReady = modelReady || probeReason === "model_unavailable"; } catch { probeReason = "runtime_failed"; } }
  const cacheDir = resolve(CONFIG.dataDir, "models/faster-whisper"); let cacheWritable = true; try { mkdirSync(cacheDir, { recursive: true }); const probe = resolve(cacheDir, ".write-probe"); writeFileSync(probe, "ok", { flag: "w", mode: 0o600 }); unlinkSync(probe); } catch { cacheWritable = false; }
  let freeDiskMb = null; try { const stat = statfsSync(CONFIG.dataDir); freeDiskMb = Math.floor(Number(stat.bavail) * Number(stat.bsize) / 1024 / 1024); } catch { /* unavailable */ }
  let status = "ready"; if (config.mode === "disabled") status = "disabled"; else if (!pythonAvailable) status = python.error && python.error.code && python.error.code !== "ENOENT" ? "runtime_failed" : "python_missing"; else if (!pythonSupported) status = "runtime_failed"; else if (!helperAvailable) status = "helper_missing"; else if (probeReason === "runtime_failed") status = "runtime_failed"; else if (!packageReady) status = probeReason === "model_unavailable" ? "model_missing" : "package_missing"; else if (!modelReady) status = "model_missing"; else if (!cacheWritable) status = "cache_unwritable";
  const nextActions = { disabled: "enable-local-aligner", python_missing: "configure-project-python", helper_missing: "restore-aligner-helper", package_missing: "bootstrap-project-local-package", model_missing: "acquire-allowlisted-local-model", cache_unwritable: "fix-managed-model-cache", runtime_failed: pythonAvailable && !pythonSupported ? "configure-python-3-9-through-3-12" : "inspect-local-runtime" };
  return { status, pythonAvailable, pythonVersion, packageReady, modelReady, helperAvailable, cacheWritable, freeDiskMb, model: config.model, device: config.device, computeType: config.computeType, alignerVersion: fasterWhisperVersion(env), nextActions: status === "ready" ? [] : [nextActions[status] || "inspect-local-runtime"] };
}

function createNarrationPreparation(fixtureValue) {
  const { fixtureId, draft } = loadFixture(fixtureValue); const words = scriptWords(draft.script); const spokenText = draft.script.beats.map((beat) => beat.spokenText).join(" ");
  const technical = { container: "wav", codecs: ["pcm_s16le", "pcm_s24le", "pcm_s32le"], sampleRate: 48000, channels: [1, 2], minimumSeconds: 1, maximumSeconds: 120, maximumBytes: 32 * 1024 * 1024 };
  const normalized = { schemaVersion: 1, profile: PREPARATION_PROFILE, operatorOnly: true, publishable: false, fixtureId, fixtureHash: draft.contentHash, language: draft.brief.language, targetSeconds: draft.brief.targetSeconds, expectedWordCount: words.length, beatIds: draft.script.beats.map((beat) => beat.id), spokenText, readingRateWpm: { minimum: 100, maximum: 210 }, wavRequirements: technical, rightsChecklist: ["commercial_use_allowed", "rights_holder_identified", "consent_reference_recorded", "license_reference_if_licensed"], recordingInstructions: ["read-exact-spoken-text", "do-not-paraphrase", "record-clean-dry-voice", "leave-no-extra-spoken-words"] };
  return { ...normalized, contentHash: sha(JSON.stringify(normalized)) };
}

function parseVolumeOutput(text) { const mean = String(text).match(/mean_volume:\s*(-?[0-9.]+)\s*dB/i); const peak = String(text).match(/max_volume:\s*(-?[0-9.]+)\s*dB/i); return { meanDb: mean ? Number(mean[1]) : null, peakDb: peak ? Number(peak[1]) : null }; }
function defaultAudioAnalysis(audioPath) { const result = spawnSync(CONFIG.ffmpegBin, ["-hide_banner", "-nostats", "-i", audioPath, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8", timeout: 30000, maxBuffer: 256 * 1024 }); if (result.status !== 0) throw new AppError("NARRATION_WAV_INVALID", SAFE_MESSAGES.NARRATION_WAV_INVALID, 415); return parseVolumeOutput(result.stderr); }

async function narrationPreflight(input = {}, dependencies = {}) {
  const { draft, fixtureId } = loadFixture(input.fixture); if (!input.rightsConfirmed) return { status: "rights_required", ready: false, fixtureId, fixtureHash: draft.contentHash, nextAction: "confirm-commercial-use-rights" };
  if (!input.audio || !isAbsolute(input.audio) || !existsSync(input.audio)) return { status: "invalid_wav", ready: false, fixtureId, fixtureHash: draft.contentHash, nextAction: "provide-authorized-wav" };
  const buffer = readFileSync(input.audio); let candidate; try { candidate = validateWavCandidate({ fileName: "authorized-narration.wav", buffer }); } catch (error) { return { status: error.code === "NARRATION_DURATION_INVALID" ? "duration_invalid" : "invalid_wav", ready: false, fixtureId, fixtureHash: draft.contentHash, nextAction: "fix-wav-container" }; }
  let media; try { const probe = await (dependencies.ffprobeJson || ffprobeJson)(input.audio); media = normalizeProbedMedia(probe, buffer.length); } catch (error) { return { status: error.code === "NARRATION_DURATION_INVALID" ? "duration_invalid" : "unsupported_audio", ready: false, fixtureId, fixtureHash: draft.contentHash, nextAction: "convert-to-48khz-pcm-wav" }; }
  let volume; try { volume = await (dependencies.analyzeAudio || defaultAudioAnalysis)(input.audio); } catch { return { status: "invalid_wav", ready: false, fixtureId, fixtureHash: draft.contentHash, nextAction: "inspect-audio-signal" }; }
  const expectedWordCount = scriptWords(draft.script).length; const readingRateWpm = Number((expectedWordCount / media.durationSeconds * 60).toFixed(2));
  if (!Number.isFinite(volume.meanDb) || volume.meanDb < -50) return { status: "silence_detected", ready: false, fixtureId, fixtureHash: draft.contentHash, media, expectedWordCount, readingRateWpm, meanDb: volume.meanDb, peakDb: volume.peakDb, nextAction: "record-audible-narration" };
  if (!Number.isFinite(volume.peakDb) || volume.peakDb >= -0.1) return { status: "clipping_risk", ready: false, fixtureId, fixtureHash: draft.contentHash, media, expectedWordCount, readingRateWpm, meanDb: volume.meanDb, peakDb: volume.peakDb, nextAction: "reduce-recording-gain" };
  if (readingRateWpm < 80 || readingRateWpm > 240) return { status: "fixture_mismatch", ready: false, fixtureId, fixtureHash: draft.contentHash, media, expectedWordCount, readingRateWpm, meanDb: volume.meanDb, peakDb: volume.peakDb, nextAction: "record-at-plausible-script-pace" };
  return { status: "ready", ready: true, fixtureId, fixtureHash: draft.contentHash, media, expectedWordCount, readingRateWpm, meanDb: volume.meanDb, peakDb: volume.peakDb, audioHash: sha(buffer), nextAction: "run-exact-script-rehearsal" };
}

async function narrationRehearsal(input = {}, dependencies = {}) {
  const { draft, fixtureId } = loadFixture(input.fixture); const doctor = (dependencies.alignerDoctor || alignerDoctor)(dependencies.env || process.env, dependencies); if (doctor.status !== "ready") return { status: "aligner_unavailable", exactMatch: false, fixtureId, fixtureHash: draft.contentHash, expectedWordCount: scriptWords(draft.script).length, alignedWordCount: 0, firstMismatchIndex: null, mismatchCategory: null, durationSeconds: null, readingRateWpm: null, nextAction: doctor.nextActions[0] || "fix-local-aligner" };
  const preflight = input.preflight || await narrationPreflight({ fixture: input.fixture, audio: input.audio, rightsConfirmed: true }, dependencies); if (!preflight.ready) return { status: preflight.status, exactMatch: false, fixtureId, fixtureHash: draft.contentHash, expectedWordCount: preflight.expectedWordCount || scriptWords(draft.script).length, alignedWordCount: 0, firstMismatchIndex: null, mismatchCategory: null, durationSeconds: preflight.media && preflight.media.durationSeconds || null, readingRateWpm: preflight.readingRateWpm || null, nextAction: preflight.nextAction };
  try { const result = await (dependencies.transcribe || transcribeWithFasterWhisper)({ audioPath: input.audio, language: draft.brief.language, env: dependencies.env || process.env, signal: input.signal }); const actual = providerWords(result); const expected = scriptWords(draft.script); assertExactScript(expected, actual); return { status: "exact_match", exactMatch: true, fixtureId, fixtureHash: draft.contentHash, expectedWordCount: expected.length, alignedWordCount: actual.length, firstMismatchIndex: null, mismatchCategory: null, durationSeconds: preflight.media.durationSeconds, readingRateWpm: preflight.readingRateWpm, nextAction: "run-pilot" }; }
  catch (error) { if (error.code === "NARRATION_SCRIPT_MISMATCH") return { status: "script_mismatch", exactMatch: false, fixtureId, fixtureHash: draft.contentHash, expectedWordCount: Number(error.details.expectedWordCount), alignedWordCount: Number(error.details.actualWordCount), firstMismatchIndex: Number(error.details.firstMismatchIndex), mismatchCategory: error.details.mismatchCategory, durationSeconds: preflight.media.durationSeconds, readingRateWpm: preflight.readingRateWpm, nextAction: "re-record-exact-approved-script" }; throw error; }
}

module.exports = { FIXTURE_ROOT, MODEL_ALLOWLIST, PREPARATION_PROFILE, alignerDoctor, createNarrationPreparation, fixtureAt, loadFixture, narrationPreflight, narrationRehearsal, parseVolumeOutput };
