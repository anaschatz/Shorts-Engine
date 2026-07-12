const { createHash } = require("node:crypto");
const { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { join, resolve } = require("node:path");
const { randomUUID } = require("node:crypto");
const { CONFIG } = require("../../../../config.cjs");
const { AppError } = require("../../../../errors.cjs");

const REPO_ROOT = resolve(__dirname, "../../../../..");
const KOKORO_RUNTIME_VERSION = "kokoro-onnx-0.5.0";
const KOKORO_MODEL_ID = "kokoro-v1.0-onnx-f32";
const KOKORO_LICENSE_REFERENCE = "Apache-2.0:hexgrad/Kokoro-82M-v1.0";
const KOKORO_VOICES = Object.freeze(["af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis"]);
const MODEL = Object.freeze({ fileName: "kokoro-v1.0.onnx", bytes: 325532387, sha256: "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5", url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx" });
const VOICES = Object.freeze({ fileName: "voices-v1.0.bin", bytes: 28214398, sha256: "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d", url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin" });

function sha256(path) { const hash = createHash("sha256"); const descriptor = openSync(path, "r"); const buffer = Buffer.allocUnsafe(1024 * 1024); try { let bytes; while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes)); } finally { closeSync(descriptor); } return hash.digest("hex"); }
function config(env = process.env) { const modelDir = resolve(env.SHORTSENGINE_KOKORO_MODEL_DIR || join(CONFIG.dataDir, "models/kokoro-v1.0")); return { pythonBin: resolve(env.SHORTSENGINE_KOKORO_PYTHON_BIN || join(REPO_ROOT, ".venv-kokoro/bin/python")), helperPath: resolve(REPO_ROOT, "tools/dark-curiosity-kokoro-synthesize.py"), modelDir, modelPath: join(modelDir, MODEL.fileName), voicesPath: join(modelDir, VOICES.fileName), timeoutMs: Math.max(1000, Math.min(180000, Number(env.SHORTSENGINE_KOKORO_TIMEOUT_MS || 120000))) }; }
function verifyFile(path, expected) { return existsSync(path) && statSync(path).size === expected.bytes && sha256(path) === expected.sha256; }
function doctor(env = process.env, dependencies = {}) {
  const runtime = config(env); const run = dependencies.spawnSync || spawnSync; let python = { status: null, stdout: "" };
  try { python = run(runtime.pythonBin, ["-c", "import importlib.metadata as m; import kokoro_onnx, soundfile; print(m.version('kokoro-onnx'))"], { encoding: "utf8", timeout: 10000, maxBuffer: 8192 }); } catch { /* bounded unavailable */ }
  const packageReady = python.status === 0 && String(python.stdout || "").trim() === "0.5.0"; const helperReady = existsSync(runtime.helperPath); const modelReady = verifyFile(runtime.modelPath, MODEL); const voicesReady = verifyFile(runtime.voicesPath, VOICES);
  const status = !existsSync(runtime.pythonBin) ? "python_missing" : !packageReady ? "package_missing" : !helperReady ? "helper_missing" : !modelReady ? "model_missing" : !voicesReady ? "voices_missing" : "ready";
  return { status, runtimeVersion: KOKORO_RUNTIME_VERSION, modelId: KOKORO_MODEL_ID, packageReady, helperReady, modelReady, voicesReady, licenseReference: KOKORO_LICENSE_REFERENCE, nextActions: status === "ready" ? [] : [status === "python_missing" || status === "package_missing" ? "install-project-local-kokoro-runtime" : status === "helper_missing" ? "restore-kokoro-helper" : "download-verified-kokoro-model"] };
}
function synthesizeWithKokoro(request, options = {}) {
  const env = options.env || process.env; const runtime = config(env); const readiness = doctor(env, options); if (readiness.status !== "ready") return Promise.reject(new AppError("TTS_PROVIDER_UNAVAILABLE", "The local Kokoro runtime is not ready.", 503, { status: readiness.status, nextActions: readiness.nextActions }));
  if (!KOKORO_VOICES.includes(request.voiceId) || request.language !== "en") return Promise.reject(new AppError("TTS_VOICE_PROHIBITED", "The Kokoro voice or language is unsupported.", 409));
  mkdirSync(join(CONFIG.dataDir, "tmp"), { recursive: true }); const outputPath = join(CONFIG.dataDir, "tmp", `kokoro-${process.pid}-${randomUUID()}.wav`);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = (options.spawn || spawn)(runtime.pythonBin, [runtime.helperPath], { stdio: ["pipe", "pipe", "pipe"] }); let stdout = ""; let stderr = ""; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); rmSync(outputPath, { force: true }); if (error) rejectPromise(error); else resolvePromise(value); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new AppError("TTS_PROVIDER_TIMEOUT", "The local Kokoro synthesis timed out.", 504)); }, runtime.timeoutMs);
    child.stdout.on("data", (chunk) => { if (stdout.length < 8192) stdout += chunk.toString("utf8"); }); child.stderr.on("data", (chunk) => { if (stderr.length < 8192) stderr += chunk.toString("utf8"); });
    child.on("error", () => finish(new AppError("TTS_PROVIDER_UNAVAILABLE", "The local Kokoro runtime could not start.", 503)));
    child.on("close", (code) => { if (settled) return; if (code !== 0 || !existsSync(outputPath)) return finish(new AppError("TTS_PROVIDER_FAILED", "Local Kokoro synthesis failed.", 502)); let result; try { result = JSON.parse(stdout); } catch { return finish(new AppError("TTS_PROVIDER_FAILED", "Local Kokoro returned an invalid result.", 502)); } if (result.status !== "complete") return finish(new AppError("TTS_PROVIDER_FAILED", "Local Kokoro synthesis failed.", 502)); const buffer = readFileSync(outputPath); finish(null, { provider: "kokoro_local", model: request.model, voiceId: request.voiceId, audioFormat: "wav", buffer, providerRequestId: `local_${request.scriptHash.slice(0, 24)}` }); });
    child.stdin.end(JSON.stringify({ text: request.script, voice: request.voiceId, speed: request.speakingRate, language: request.language, modelPath: runtime.modelPath, voicesPath: runtime.voicesPath, outputPath }));
  });
}

module.exports = { KOKORO_LICENSE_REFERENCE, KOKORO_MODEL_ID, KOKORO_RUNTIME_VERSION, KOKORO_VOICES, MODEL, VOICES, config, doctor, sha256, synthesizeWithKokoro, verifyFile };
