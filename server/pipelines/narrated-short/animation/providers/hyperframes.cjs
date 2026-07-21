const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { basename, join, relative, resolve } = require("node:path");
const { AppError } = require("../../../../errors.cjs");
const {
  normalizeDraftBundle,
} = require("../../contracts.cjs");
const { validateAnimationIR } = require("../contract.cjs");
const { validateComplexityBudget } = require("../complexity-budget.cjs");
const {
  normalizeAnimationTimingContext,
} = require("../timing-contract.cjs");

const PROVIDER_ID = "hyperframes_benchmark";
const WORKER_PATH = resolve(__dirname, "../../../../../renderer/hyperframes/render-worker.mjs");
const WORKER_FAILURE_STAGES = new Set([
  "startup",
  "argument_validation",
  "request_validation",
  "source_binding",
  "ir_validation",
  "composition_compile",
  "runtime_doctor",
  "composition_write",
  "render_execute",
  "output_hash",
]);
const PROVIDER_FAILURE_STAGES = new Set([
  "request_validation",
  "staging_validation",
  "source_binding",
  "private_input_write",
  "worker_spawn",
  "diagnostic_budget",
  "worker_process",
  "worker_signaled",
  "worker_dependency_missing",
  "worker_memory_exhausted",
  "worker_syntax_invalid",
  "worker_permission_denied",
  "worker_loopback_denied",
  "worker_exit_nonzero",
  "completion_missing",
  "output_invalid",
  "output_name_mismatch",
  "ir_hash_mismatch",
  "output_hash_invalid",
  "composition_hash_invalid",
]);

function inside(root, target) { const value = relative(resolve(root), resolve(target)); return value && !value.startsWith("..") && !value.includes("/../"); }
function safeFailure(code = "ANIMATION_RENDER_FAILED", details = null) { return new AppError(code, code === "ANIMATION_RENDER_CANCELLED" ? "Animation render was cancelled." : "Animation render failed safely.", code === "ANIMATION_RENDER_CANCELLED" ? 409 : 500, details); }
function stagedFailure(stage, code = "ANIMATION_RENDER_FAILED") {
  return safeFailure(
    code,
    PROVIDER_FAILURE_STAGES.has(stage) ? { renderStage: stage } : null,
  );
}

function classifyWorkerExit(stderr, signalName) {
  if (signalName) return "worker_signaled";
  if (/listen EPERM[^\n]*127\.0\.0\.1/i.test(stderr)) {
    return "worker_loopback_denied";
  }
  if (/ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/i.test(stderr)) {
    return "worker_dependency_missing";
  }
  if (/heap out of memory|FATAL ERROR/i.test(stderr)) {
    return "worker_memory_exhausted";
  }
  if (/SyntaxError/i.test(stderr)) return "worker_syntax_invalid";
  if (/EACCES|permission denied/i.test(stderr)) {
    return "worker_permission_denied";
  }
  return "worker_exit_nonzero";
}

function resolveStagingDir(value) {
  try {
    const candidate = resolve(value || "");
    if (!value || candidate === "/") throw new Error("invalid_staging");
    const stagingDir = realpathSync(candidate);
    const stats = statSync(stagingDir);
    if (!stats.isDirectory() || (stats.mode & 0o022) !== 0) {
      throw new Error("unsafe_staging");
    }
    return stagingDir;
  } catch {
    throw safeFailure();
  }
}

function createRenderStagingDir(root) {
  try {
    const stagingDir = mkdtempSync(join(root, ".hyperframes-render-"));
    chmodSync(stagingDir, 0o700);
    return realpathSync(stagingDir);
  } catch {
    throw safeFailure();
  }
}

function privateOutputName(value) {
  const outputName = value || "visual-master.mp4";
  if (
    typeof outputName !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.mp4$/.test(outputName)
    || basename(outputName) !== outputName
  ) throw safeFailure();
  return outputName;
}

function removeFile(path) {
  rmSync(path, { force: true });
}

function writePrivateFile(path, value) {
  removeFile(path);
  const noFollow = Number.isInteger(constants.O_NOFOLLOW)
    ? constants.O_NOFOLLOW
    : 0;
  const fd = openSync(
    path,
    constants.O_WRONLY
      | constants.O_CREAT
      | constants.O_EXCL
      | noFollow,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, value, { encoding: "utf8" });
  } finally {
    closeSync(fd);
  }
}

function bestEffortRemove(paths) {
  for (const path of paths) {
    try {
      removeFile(path);
    } catch {
      // The caller receives only a safe provider failure.
    }
  }
}

function bestEffortRemoveTree(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // The caller receives only a safe provider failure.
  }
}

async function doctor() {
  const { hyperframesDoctor } = await import("../../../../../renderer/hyperframes/doctor.mjs");
  const report = await hyperframesDoctor();
  return { ready: report.ready, provider: report.provider, runtimeVersion: report.runtimeVersion, nodeVersion: report.nodeVersion, checks: report.checks };
}

function validateForProvider(animationIR, providerId, validationContext = {}) {
  const ir = validateAnimationIR(animationIR, validationContext);
  const budget = validateComplexityBudget(ir);
  if (ir.renderer.provider !== providerId) throw new AppError("ANIMATION_PROVIDER_MISMATCH", "AnimationIR renderer binding does not match the selected provider.", 409);
  const generalizedGraph = (
    ir.content?.semanticEventGraph?.primitivePayloadProfileId === undefined
      ? null
      : ir.content.semanticEventGraph
  );
  return Object.freeze({
    animationIR: ir,
    budget,
    sourceValidatedSemanticEventGraphHash:
      generalizedGraph?.contentHash || null,
  });
}

function normalizeSemanticSourceContext(value) {
  if (!value) return null;
  return Object.freeze({
    draft: normalizeDraftBundle(value.draft),
    timingContext: normalizeAnimationTimingContext(value.timingContext),
  });
}

function estimateValidated({ animationIR, budget }) {
  const pixels = animationIR.width * animationIR.height * animationIR.durationFrames;
  return Object.freeze({ frames: animationIR.durationFrames, durationSeconds: animationIR.durationFrames / animationIR.fps, complexityCost: budget.computedCost, estimatedMemoryMb: Math.ceil(250 + pixels / 1.8e6), expectedDurationSeconds: Math.ceil(8 + pixels / 7e6) });
}

function estimateForProvider(request, providerId) {
  return estimateValidated(
    request.animationIR
      ? validateForProvider(request.animationIR, providerId)
      : request,
  );
}

function renderWithSpawn(spawnImpl, workerPath, providerId, request, signal, onProgress = () => {}) {
  const validated = request.validated;
  if (!validated?.animationIR) return Promise.reject(stagedFailure("request_validation"));
  let stagingDir;
  let outputName;
  try {
    const stagingRoot = resolveStagingDir(request.stagingDir);
    outputName = privateOutputName(request.outputName);
    stagingDir = createRenderStagingDir(stagingRoot);
  } catch (error) {
    return Promise.reject(stagedFailure("staging_validation"));
  }
  const irPath = join(stagingDir, "animation-ir.json");
  const requestPath = join(stagingDir, "render-request.json");
  const sourceContextPath = join(stagingDir, "semantic-source-context.json");
  const htmlPath = join(stagingDir, "index.html");
  const outputPath = join(stagingDir, outputName);
  const privateInputPaths = [irPath, requestPath, sourceContextPath];
  if (
    ![...privateInputPaths, htmlPath, outputPath]
      .every((path) => inside(stagingDir, path))
  ) {
    bestEffortRemoveTree(stagingDir);
    return Promise.reject(stagedFailure("staging_validation"));
  }
  const generalized =
    Boolean(validated.sourceValidatedSemanticEventGraphHash);
  if (generalized && !request.semanticSourceContext) {
    bestEffortRemoveTree(stagingDir);
    return Promise.reject(stagedFailure(
      "source_binding",
      "ANIMATION_SOURCE_BINDING_INVALID",
    ));
  }
  try {
    bestEffortRemove([htmlPath, outputPath]);
    writePrivateFile(
      irPath,
      `${JSON.stringify(validated.animationIR, null, 2)}\n`,
    );
    if (generalized) {
      writePrivateFile(
        sourceContextPath,
        `${JSON.stringify(request.semanticSourceContext, null, 2)}\n`,
      );
    } else {
      removeFile(sourceContextPath);
    }
    writePrivateFile(requestPath, `${JSON.stringify({
      stagingDir,
      irPath,
      outputPath,
      quality: request.quality || "standard",
    })}\n`);
  } catch {
    bestEffortRemoveTree(stagingDir);
    return Promise.reject(stagedFailure("private_input_write"));
  }
  const timeoutMs = Math.max(1000, Math.min(Number(request.timeoutMs || 120000), 1800000));
  return new Promise((resolvePromise, reject) => {
    const processGroup = process.platform !== "win32";
    const workerArgs = [
      workerPath,
      "--request",
      requestPath,
      "--expected-animation-ir-hash",
      validated.animationIR.contentHash,
    ];
    if (generalized) {
      workerArgs.push(
        "--semantic-source-context",
        sourceContextPath,
        "--expected-draft-hash",
        validated.animationIR.draftHash,
        "--expected-timing-context-hash",
        validated.animationIR.timingBinding.timingContextHash,
      );
    }
    let child;
    try {
      child = spawnImpl(process.execPath, workerArgs, { cwd: resolve(__dirname, "../../../../../"), detached: processGroup, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "", TMPDIR: process.env.TMPDIR || "/tmp", LANG: "C.UTF-8", HYPERFRAMES_EXTRACT_CACHE_DIR: "off" } });
    } catch {
      bestEffortRemoveTree(stagingDir);
      reject(stagedFailure("worker_spawn"));
      return;
    }
    let stdout = "", stderr = "", stderrBytes = 0, complete = null, settled = false, progressCount = 0, pendingError = null, workerFailureStage = null;
    let forceKillTimer = null;
    let forceSettleTimer = null;
    const cleanupInputs = () => bestEffortRemove([
      ...privateInputPaths,
      htmlPath,
    ]);
    const cleanupFailure = () => bestEffortRemoveTree(stagingDir);
    const clearLifecycle = () => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      signal?.removeEventListener("abort", abort);
    };
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      clearLifecycle();
      cleanupFailure();
      reject(error);
    };
    const kill = (signalName) => {
      if (processGroup && Number.isInteger(child.pid)) {
        try {
          process.kill(-child.pid, signalName);
          return;
        } catch {
          // Fall back to the direct child below.
        }
      }
      try {
        child.kill(signalName);
      } catch {
        // The final settlement timer still closes the provider promise.
      }
    };
    const stop = (error) => {
      if (settled || pendingError) return;
      pendingError = error;
      kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        kill("SIGKILL");
        forceSettleTimer = setTimeout(
          () => finishError(pendingError),
          500,
        );
      }, 500);
    };
    const timer = setTimeout(() => stop(safeFailure("ANIMATION_RENDER_TIMEOUT")), timeoutMs);
    const abort = () => stop(safeFailure("ANIMATION_RENDER_CANCELLED"));
    if (signal?.aborted) stop(safeFailure("ANIMATION_RENDER_CANCELLED"));
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 65536) return stop(stagedFailure("diagnostic_budget"));
      const lines = stdout.split("\n"); stdout = lines.pop();
      for (const line of lines) {
        if (!line || line.length > 1024) continue;
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "progress" && progressCount++ < 200) onProgress({ stage: event.stage, percent: event.percent });
        if (event.type === "complete") complete = event;
        if (
          event.type === "error"
          && WORKER_FAILURE_STAGES.has(event.stage)
        ) workerFailureStage = event.stage;
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 65536) return stop(stagedFailure("diagnostic_budget"));
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => finishError(stagedFailure("worker_process")));
    child.on("close", (code, signalName) => {
      if (settled) return;
      if (pendingError) return finishError(pendingError);
      let outputValid = false;
      try {
        const stats = lstatSync(outputPath);
        outputValid = (
          stats.isFile()
          && !stats.isSymbolicLink()
          && inside(stagingDir, realpathSync(outputPath))
        );
      } catch {
        outputValid = false;
      }
      let closeFailureStage = null;
      if (code !== 0) {
        closeFailureStage = classifyWorkerExit(stderr, signalName);
      }
      else if (!complete) closeFailureStage = "completion_missing";
      else if (!outputValid) closeFailureStage = "output_invalid";
      else if (complete.outputFile !== outputName) {
        closeFailureStage = "output_name_mismatch";
      } else if (
        complete.animationIRHash !== validated.animationIR.contentHash
      ) closeFailureStage = "ir_hash_mismatch";
      else if (!/^[a-f0-9]{64}$/.test(complete.outputSha256 || "")) {
        closeFailureStage = "output_hash_invalid";
      } else if (!/^[a-f0-9]{64}$/.test(complete.compositionHash || "")) {
        closeFailureStage = "composition_hash_invalid";
      }
      if (closeFailureStage) return finishError(workerFailureStage
        ? safeFailure("ANIMATION_RENDER_FAILED", {
          workerStage: workerFailureStage,
        })
        : stagedFailure(closeFailureStage));
      settled = true;
      clearLifecycle();
      cleanupInputs();
      resolvePromise(Object.freeze({ ...complete, outputPath, stagingDir }));
    });
  });
}

function verifyManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || !manifest.outputPath || !existsSync(manifest.outputPath)) throw safeFailure("ANIMATION_MANIFEST_INVALID");
  let fd;
  let output;
  try {
    const noFollow = Number.isInteger(constants.O_NOFOLLOW)
      ? constants.O_NOFOLLOW
      : 0;
    fd = openSync(manifest.outputPath, constants.O_RDONLY | noFollow);
    if (!fstatSync(fd).isFile()) throw new Error("output_not_regular");
    output = readFileSync(fd);
  } catch {
    throw safeFailure("ANIMATION_MANIFEST_INVALID");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const actual = createHash("sha256").update(output).digest("hex");
  if (actual !== manifest.outputSha256 || !/^[a-f0-9]{64}$/.test(manifest.animationIRHash || "")) throw safeFailure("ANIMATION_OUTPUT_TAMPERED");
  return Object.freeze({ valid: true, outputSha256: actual, animationIRHash: manifest.animationIRHash });
}

function createHyperframesProvider(dependencies = {}) {
  const spawnImpl = dependencies.spawnImpl || spawn;
  const workerPath = dependencies.workerPath || WORKER_PATH;
  const providerId = dependencies.providerId || PROVIDER_ID;
  const validationReceipts = new WeakSet();
  const receiptSourceContexts = new WeakMap();
  const renderReceipts = new WeakMap();
  const validateOwned = (animationIR, validationContext = {}) => {
    const semanticSourceContext = normalizeSemanticSourceContext(
      validationContext.semanticSourceContext,
    );
    const validated = validateForProvider(
      animationIR,
      providerId,
      {
        ...validationContext,
        ...(semanticSourceContext ? { semanticSourceContext } : {}),
      },
    );
    validationReceipts.add(validated);
    if (
      validated.sourceValidatedSemanticEventGraphHash
      && semanticSourceContext
    ) {
      receiptSourceContexts.set(validated, semanticSourceContext);
    }
    return validated;
  };
  const verifyOwned = (manifest) => {
    const expected = renderReceipts.get(manifest);
    if (
      !expected
      || manifest.outputPath !== expected.outputPath
      || manifest.outputSha256 !== expected.outputSha256
      || manifest.animationIRHash !== expected.animationIRHash
      || manifest.compositionHash !== expected.compositionHash
    ) throw safeFailure("ANIMATION_MANIFEST_INVALID");
    return verifyManifest(manifest);
  };
  return Object.freeze({
    id: providerId,
    doctor,
    validate: validateOwned,
    estimate: (request) => (
      validationReceipts.has(request)
        ? estimateValidated(request)
        : estimateForProvider(request, providerId)
    ),
    render: (request = {}, signal, onProgress) => {
      let validated = request.validated;
      if (request.animationIR) {
        try {
          validated = validateOwned(
            request.animationIR,
            request.validationContext || {},
          );
        } catch (error) {
          return Promise.reject(error);
        }
      } else if (!validationReceipts.has(validated)) {
        return Promise.reject(safeFailure("ANIMATION_SOURCE_BINDING_INVALID"));
      }
      return renderWithSpawn(
        spawnImpl,
        workerPath,
        providerId,
        {
          ...request,
          animationIR: undefined,
          validated,
          semanticSourceContext: receiptSourceContexts.get(validated) || null,
        },
        signal,
        onProgress,
      ).then((result) => {
        renderReceipts.set(result, Object.freeze({
          outputPath: result.outputPath,
          outputSha256: result.outputSha256,
          animationIRHash: result.animationIRHash,
          compositionHash: result.compositionHash,
        }));
        return result;
      });
    },
    verify: verifyOwned,
  });
}

module.exports = Object.freeze({ ...createHyperframesProvider(), createHyperframesProvider });
