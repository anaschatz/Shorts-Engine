const { spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { join, resolve } = require("node:path");

const { CONFIG } = require("../../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../../errors.cjs");
const { isInside } = require("../../storage.cjs");
const {
  ACTION,
  PROFILE_IDS,
  createMotivationalWorkerResult,
  normalizeMotivationalSourceShortJobPayload,
} = require("./contracts.cjs");

const REPOSITORY_ROOT = resolve(__dirname, "../../..");
const ENGINE_ROOT = join(REPOSITORY_ROOT, "AI-Youtube-Shorts-Generator");
const ENGINE_MAIN = join(ENGINE_ROOT, "main.py");
const DEFAULT_VENV_PYTHON = join(ENGINE_ROOT, ".venv", "bin", "python");
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DISCOVERY_ONLY_MODE = "discovery_only";
const MAX_CAPTURE_BYTES = 64 * 1024;

function workerFailure(phase, code = "MOTIVATIONAL_WORKER_FAILED", status = 500, details = {}) {
  return new AppError(code, SAFE_MESSAGES[code] || SAFE_MESSAGES.RENDER_FAILED, status, { phase, ...details });
}

function appendBounded(current, chunk) {
  const next = `${current}${chunk.toString("utf8")}`;
  return next.length > MAX_CAPTURE_BYTES ? next.slice(-MAX_CAPTURE_BYTES) : next;
}

function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("end", () => resolvePromise(digest.digest("hex")));
  });
}

function defaultPythonBin() {
  return existsSync(DEFAULT_VENV_PYTHON)
    ? DEFAULT_VENV_PYTHON
    : process.env.SHORTSENGINE_MOTIVATIONAL_PYTHON_BIN || "python3";
}

function buildPythonWorkerArgs(job, outputJsonPath, workerScript = ENGINE_MAIN) {
  const payload = normalizeMotivationalSourceShortJobPayload(job);
  const args = [
    resolve(workerScript),
    payload.sourcePath,
    "--mode", "local",
    "--num-clips", "1",
    "--aspect-ratio", "9:16",
    "--format", payload.downloadFormat,
    "--format-profile", PROFILE_IDS.formatProfile,
    "--output-json", resolve(outputJsonPath),
  ];
  if (payload.language !== "auto") args.push("--language", payload.language);
  return args;
}

function safeExistingFile(path, root, field) {
  const target = String(path || "").trim();
  let realRoot;
  let realTarget;
  try {
    realRoot = realpathSync(root);
    realTarget = realpathSync(target);
  } catch {
    throw workerFailure("validate_result_path", "MOTIVATIONAL_WORKER_RESULT_INVALID", 500, { field });
  }
  if (!isInside(realRoot, realTarget)) {
    throw workerFailure("validate_result_path", "STORAGE_PATH_UNSAFE", 403, { field });
  }
  let stats;
  try {
    stats = statSync(realTarget);
  } catch {
    throw workerFailure("validate_result_path", "MOTIVATIONAL_WORKER_RESULT_INVALID", 500, { field });
  }
  if (!stats.isFile() || stats.size <= 0) {
    throw workerFailure("validate_result_path", "MOTIVATIONAL_WORKER_RESULT_INVALID", 500, { field });
  }
  return { path: realTarget, stats };
}

function normalizeEngineProfiles(raw) {
  const profiles = raw && raw.profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    throw workerFailure("validate_profiles", "MOTIVATIONAL_WORKER_RESULT_INVALID");
  }
  const mapped = {
    contentProfile: profiles.content_profile,
    selectionProfile: profiles.selection_profile,
    renderProfile: profiles.render_profile,
    formatProfile: profiles.format_profile,
  };
  for (const [field, expected] of Object.entries(PROFILE_IDS)) {
    if (String(mapped[field] || "").trim().toLowerCase() !== expected) {
      throw workerFailure("validate_profiles", "MOTIVATIONAL_WORKER_RESULT_INVALID", 500, { field });
    }
  }
  return PROFILE_IDS;
}

function bindingValue(bindings, camel, snake) {
  return String(bindings[camel] || bindings[snake] || "").trim().toLowerCase().replace(/^sha256:/, "");
}

function validateEngineBindings(raw, job) {
  const bindings = raw && (raw.controlPlaneBindings || raw.control_plane_bindings);
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    throw workerFailure("validate_bindings", "MOTIVATIONAL_WORKER_RESULT_INVALID");
  }
  const allowedFields = new Set([
    "sourceHash",
    "source_hash",
    "rightsManifestHash",
    "rights_manifest_hash",
    "candidateDecisionHash",
    "candidate_decision_hash",
    "candidateHash",
    "candidate_hash",
    "experimentManifestHash",
    "experiment_manifest_hash",
    "transcriptManifestHash",
    "transcript_manifest_hash",
  ]);
  if (Object.keys(bindings).some((field) => !allowedFields.has(field))) {
    throw workerFailure("validate_bindings", "MOTIVATIONAL_WORKER_RESULT_INVALID");
  }
  const normalized = {
    sourceHash: bindingValue(bindings, "sourceHash", "source_hash"),
    rightsManifestHash: bindingValue(bindings, "rightsManifestHash", "rights_manifest_hash"),
    candidateDecisionHash: bindingValue(
      bindings,
      "candidateDecisionHash",
      "candidate_decision_hash",
    ),
    candidateHash: bindingValue(bindings, "candidateHash", "candidate_hash"),
    experimentManifestHash: bindingValue(
      bindings,
      "experimentManifestHash",
      "experiment_manifest_hash",
    ),
    transcriptManifestHash: bindingValue(
      bindings,
      "transcriptManifestHash",
      "transcript_manifest_hash",
    ),
  };
  const expected = {
    sourceHash: job.sourceHash,
    rightsManifestHash: job.rightsManifestHash,
    candidateDecisionHash: job.candidateDecisionHash,
    candidateHash: job.candidateDecision.candidateHash,
    experimentManifestHash: job.experimentManifestHash,
    transcriptManifestHash: job.transcriptManifestHash,
  };
  for (const field of Object.keys(normalized)) {
    if (!/^[a-f0-9]{64}$/.test(normalized[field]) || normalized[field] !== expected[field]) {
      throw workerFailure("validate_bindings", "MOTIVATIONAL_WORKER_RESULT_INVALID", 500, { field });
    }
  }
  return normalized;
}

function validateEngineSource(raw, job) {
  if (!raw || raw.mode !== "local") {
    throw workerFailure("validate_mode", "MOTIVATIONAL_WORKER_RESULT_INVALID");
  }
  let workerSource;
  try {
    workerSource = realpathSync(String(raw.source_video_url || ""));
  } catch {
    throw workerFailure("validate_source", "MOTIVATIONAL_WORKER_RESULT_INVALID");
  }
  if (workerSource !== job.sourcePath) {
    throw workerFailure("validate_source", "MOTIVATIONAL_WORKER_RESULT_INVALID");
  }
}

async function normalizeEngineResult(raw, job, options = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw workerFailure("parse_result", "MOTIVATIONAL_WORKER_RESULT_INVALID");
  }
  normalizeEngineProfiles(raw);
  validateEngineBindings(raw, job);
  validateEngineSource(raw, job);
  if (!Array.isArray(raw.shorts) || raw.shorts.length !== 1 || raw.shorts[0].error) {
    throw workerFailure("validate_output_count", "MOTIVATIONAL_WORKER_RESULT_INVALID");
  }
  const short = raw.shorts[0];
  if (Number(short.output_rank) !== 1) {
    throw workerFailure("validate_output_rank", "MOTIVATIONAL_WORKER_RESULT_INVALID");
  }
  if (
    String(short.candidate_hash || "").trim().toLowerCase()
    !== job.candidateDecision.candidateHash
  ) {
    throw workerFailure("validate_approved_candidate", "MOTIVATIONAL_WORKER_RESULT_INVALID");
  }
  const output = safeExistingFile(short.clip_url, options.outputRoot, "shorts[0].clip_url");
  const outputHash = await sha256File(output.path);
  const start = Number(short.start_time);
  const end = Number(short.end_time);
  const durationSeconds = end - start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || durationSeconds < 8 || durationSeconds > 22.5) {
    throw workerFailure("validate_duration", "MOTIVATIONAL_WORKER_RESULT_INVALID");
  }
  if (!raw.ranking || typeof raw.ranking !== "object") {
    throw workerFailure("validate_ranking", "MOTIVATIONAL_WORKER_RESULT_INVALID");
  }
  const ranking = safeExistingFile(
    raw.ranking.manifest_path,
    options.outputRoot,
    "ranking.manifest_path",
  );
  const rankingHash = await sha256File(ranking.path);
  return createMotivationalWorkerResult({
    profiles: job.profiles,
    sourceHash: job.sourceHash,
    rightsManifestHash: job.rightsManifestHash,
    candidateDecisionHash: job.candidateDecisionHash,
    candidateHash: job.candidateDecision.candidateHash,
    experimentManifestHash: job.experimentManifestHash,
    transcriptManifestHash: job.transcriptManifestHash,
    output: {
      localPath: output.path,
      outputHash,
      sizeBytes: output.stats.size,
      outputRank: 1,
      durationSeconds: Number(durationSeconds.toFixed(3)),
    },
    ranking: {
      manifestPath: ranking.path,
      manifestHash: rankingHash,
    },
    completedAt: options.now().toISOString(),
  });
}

function spawnAndWait(spawnImpl, binary, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawnImpl(binary, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(workerFailure("spawn"));
      return;
    }
    if (!child || !child.stdout || !child.stderr || typeof child.on !== "function") {
      reject(workerFailure("spawn", "ADAPTER_CONTRACT_INVALID"));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const abort = () => {
      if (typeof child.kill === "function") child.kill("SIGTERM");
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", abort);
      callback();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (typeof child.kill === "function") child.kill("SIGKILL");
    }, options.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", () => finish(() => reject(workerFailure("spawn"))));
    child.on("close", (code) => finish(() => {
      if (options.signal && options.signal.aborted) {
        reject(new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409));
      } else if (timedOut) {
        reject(workerFailure("timeout"));
      } else if (code !== 0) {
        reject(workerFailure("python_exit", "MOTIVATIONAL_WORKER_FAILED", 500, { exitCode: code }));
      } else {
        resolvePromise({ stdout, stderr });
      }
    }));
  });
}

function createPythonMotivationalWorker(options = {}) {
  if (options.mode !== DISCOVERY_ONLY_MODE) {
    throw new AppError(
      "PIPELINE_HANDLER_UNAVAILABLE",
      "The requested pipeline is not available.",
      503,
      { action: ACTION, adapterMode: DISCOVERY_ONLY_MODE },
    );
  }
  const spawnImpl = options.spawnImpl || spawn;
  const pythonBin = String(options.pythonBin || defaultPythonBin()).trim();
  const workerScript = resolve(options.workerScript || ENGINE_MAIN);
  const engineRoot = resolve(options.engineRoot || ENGINE_ROOT);
  const outputRoot = resolve(options.outputRoot || CONFIG.renderDir);
  const tempRoot = resolve(options.tempRoot || CONFIG.tmpDir);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const now = typeof options.now === "function" ? options.now : () => new Date();
  if (!pythonBin || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 2 * 60 * 60 * 1000) {
    throw workerFailure("configure", "ADAPTER_CONTRACT_INVALID");
  }

  return async function runPythonMotivationalWorker(payload, runtime = {}) {
    const job = normalizeMotivationalSourceShortJobPayload(payload);
    if (!existsSync(workerScript)) throw workerFailure("worker_script_missing", "ADAPTER_CONTRACT_INVALID");
    mkdirSync(outputRoot, { recursive: true });
    mkdirSync(tempRoot, { recursive: true });
    const actualSourceHash = await sha256File(job.sourcePath);
    if (actualSourceHash !== job.sourceHash) {
      throw new AppError(
        "SOURCE_CACHE_CHECKSUM_MISMATCH",
        SAFE_MESSAGES.SOURCE_CACHE_CHECKSUM_MISMATCH,
        409,
        { field: "sourceHash" },
      );
    }
    const outputJsonPath = join(tempRoot, `motivational-worker-${randomUUID()}.json`);
    const controlInputPath = join(tempRoot, `motivational-control-${randomUUID()}.json`);
    const controlInput = {
      schemaVersion: 1,
      candidateDecision: job.candidateDecision,
      experimentManifest: job.experimentManifest,
      transcriptManifest: job.transcriptManifest,
    };
    const controlInputBytes = `${JSON.stringify(controlInput)}\n`;
    try {
      writeFileSync(controlInputPath, controlInputBytes, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const controlInputHash = createHash("sha256").update(controlInputBytes).digest("hex");
      const args = buildPythonWorkerArgs(job, outputJsonPath, workerScript);
      const env = {
        ...process.env,
        ...(options.env || {}),
        LOCAL_OUTPUT_DIR: outputRoot,
        SHORTSENGINE_CONTROL_SOURCE_SHA256: job.sourceHash,
        SHORTSENGINE_CONTROL_RIGHTS_MANIFEST_SHA256: job.rightsManifestHash,
        SHORTSENGINE_CONTROL_CANDIDATE_DECISION_SHA256: job.candidateDecisionHash,
        SHORTSENGINE_CONTROL_APPROVED_CANDIDATE_SHA256: job.candidateDecision.candidateHash,
        SHORTSENGINE_CONTROL_EXPERIMENT_MANIFEST_SHA256: job.experimentManifestHash,
        SHORTSENGINE_CONTROL_TRANSCRIPT_MANIFEST_SHA256: job.transcriptManifestHash,
        SHORTSENGINE_CONTROL_INPUT_PATH: controlInputPath,
        SHORTSENGINE_CONTROL_INPUT_SHA256: controlInputHash,
      };
      await spawnAndWait(spawnImpl, pythonBin, args, {
        cwd: engineRoot,
        env,
        signal: runtime.signal,
        timeoutMs,
      });
      let raw;
      try {
        raw = JSON.parse(readFileSync(outputJsonPath, "utf8"));
      } catch {
        throw workerFailure("parse_output_json", "MOTIVATIONAL_WORKER_RESULT_INVALID");
      }
      return await normalizeEngineResult(raw, job, { outputRoot, now });
    } finally {
      try {
        unlinkSync(outputJsonPath);
      } catch {
        // The worker may fail before creating its result file.
      }
      try {
        unlinkSync(controlInputPath);
      } catch {
        // The input is always local and removed after success or failure.
      }
    }
  };
}

function createMotivationalSourceShortHandler() {
  // Intentionally never promotes the discovery bridge into a production job
  // handler. Production wiring must inject runMotivationalSourceShortJob.
  return async function motivationalSourceShortHandler() {
    throw new AppError(
      "PIPELINE_HANDLER_UNAVAILABLE",
      "The requested pipeline is not available.",
      503,
      { action: ACTION, adapterMode: DISCOVERY_ONLY_MODE },
    );
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DISCOVERY_ONLY_MODE,
  ENGINE_MAIN,
  ENGINE_ROOT,
  buildPythonWorkerArgs,
  createMotivationalSourceShortHandler,
  createPythonMotivationalWorker,
  normalizeEngineResult,
  sha256File,
};
