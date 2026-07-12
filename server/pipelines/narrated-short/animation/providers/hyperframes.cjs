const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } = require("node:fs");
const { join, relative, resolve } = require("node:path");
const { AppError } = require("../../../../errors.cjs");
const { validateAnimationIR } = require("../contract.cjs");
const { validateComplexityBudget } = require("../complexity-budget.cjs");

const PROVIDER_ID = "hyperframes_benchmark";
const WORKER_PATH = resolve(__dirname, "../../../../../renderer/hyperframes/render-worker.mjs");

function inside(root, target) { const value = relative(resolve(root), resolve(target)); return value && !value.startsWith("..") && !value.includes("/../"); }
function safeFailure(code = "ANIMATION_RENDER_FAILED") { return new AppError(code, code === "ANIMATION_RENDER_CANCELLED" ? "Animation render was cancelled." : "Animation render failed safely.", code === "ANIMATION_RENDER_CANCELLED" ? 409 : 500); }

async function doctor() {
  const { hyperframesDoctor } = await import("../../../../../renderer/hyperframes/doctor.mjs");
  const report = await hyperframesDoctor();
  return { ready: report.ready, provider: report.provider, runtimeVersion: report.runtimeVersion, nodeVersion: report.nodeVersion, checks: report.checks };
}

function validate(animationIR) {
  const ir = validateAnimationIR(animationIR);
  const budget = validateComplexityBudget(ir);
  if (ir.renderer.provider !== PROVIDER_ID) throw new AppError("ANIMATION_PROVIDER_MISMATCH", "AnimationIR renderer binding does not match the selected provider.", 409);
  return Object.freeze({ animationIR: ir, budget });
}

function estimate(request) {
  const { animationIR, budget } = request.animationIR ? validate(request.animationIR) : request;
  const pixels = animationIR.width * animationIR.height * animationIR.durationFrames;
  return Object.freeze({ frames: animationIR.durationFrames, durationSeconds: animationIR.durationFrames / animationIR.fps, complexityCost: budget.computedCost, estimatedMemoryMb: Math.ceil(250 + pixels / 1.8e6), expectedDurationSeconds: Math.ceil(8 + pixels / 7e6) });
}

function renderWithSpawn(spawnImpl, workerPath, request, signal, onProgress = () => {}) {
  const validated = request.animationIR ? validate(request.animationIR) : request.validated;
  if (!validated?.animationIR) return Promise.reject(safeFailure());
  const stagingDir = resolve(request.stagingDir || "");
  if (!stagingDir || stagingDir === "/" || !existsSync(stagingDir)) return Promise.reject(safeFailure());
  const irPath = join(stagingDir, "animation-ir.json");
  const requestPath = join(stagingDir, "render-request.json");
  const outputPath = join(stagingDir, request.outputName || "visual-master.mp4");
  if (![irPath, requestPath, outputPath].every((path) => inside(stagingDir, path))) return Promise.reject(safeFailure());
  writeFileSync(irPath, `${JSON.stringify(validated.animationIR, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  writeFileSync(requestPath, `${JSON.stringify({ stagingDir, irPath, outputPath, quality: request.quality || "standard" })}\n`, { encoding: "utf8", mode: 0o600 });
  const timeoutMs = Math.max(1000, Math.min(Number(request.timeoutMs || 120000), 300000));
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl(process.execPath, [workerPath, "--request", requestPath], { cwd: resolve(__dirname, "../../../../../"), stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "", TMPDIR: process.env.TMPDIR || "/tmp", LANG: "C.UTF-8", HYPERFRAMES_EXTRACT_CACHE_DIR: "off" } });
    let stdout = "", stderrBytes = 0, complete = null, settled = false, progressCount = 0, pendingError = null;
    const cleanup = () => { for (const path of [outputPath, join(stagingDir, "index.html")]) rmSync(path, { force: true }); };
    const finishError = (error) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const stop = (error) => { if (settled || pendingError) return; pendingError = error; child.kill("SIGTERM"); };
    const timer = setTimeout(() => stop(safeFailure("ANIMATION_RENDER_TIMEOUT")), timeoutMs);
    const abort = () => stop(safeFailure("ANIMATION_RENDER_CANCELLED"));
    if (signal?.aborted) stop(safeFailure("ANIMATION_RENDER_CANCELLED"));
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 65536) return stop(safeFailure());
      const lines = stdout.split("\n"); stdout = lines.pop();
      for (const line of lines) {
        if (!line || line.length > 1024) continue;
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "progress" && progressCount++ < 200) onProgress({ stage: event.stage, percent: event.percent });
        if (event.type === "complete") complete = event;
      }
    });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; if (stderrBytes > 65536) stop(safeFailure()); });
    child.on("error", () => finishError(safeFailure()));
    child.on("close", (code) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (settled) return;
      if (pendingError) return finishError(pendingError);
      if (code !== 0 || !complete || !existsSync(outputPath)) return finishError(safeFailure());
      settled = true;
      resolvePromise(Object.freeze({ ...complete, outputPath, stagingDir }));
    });
  });
}

function verify(manifest) {
  if (!manifest || typeof manifest !== "object" || !manifest.outputPath || !existsSync(manifest.outputPath)) throw safeFailure("ANIMATION_MANIFEST_INVALID");
  const actual = createHash("sha256").update(readFileSync(manifest.outputPath)).digest("hex");
  if (actual !== manifest.outputSha256 || !/^[a-f0-9]{64}$/.test(manifest.animationIRHash || "")) throw safeFailure("ANIMATION_OUTPUT_TAMPERED");
  return Object.freeze({ valid: true, outputSha256: actual, animationIRHash: manifest.animationIRHash });
}

function createHyperframesProvider(dependencies = {}) {
  const spawnImpl = dependencies.spawnImpl || spawn;
  const workerPath = dependencies.workerPath || WORKER_PATH;
  return Object.freeze({ id: PROVIDER_ID, doctor, validate, estimate, render: (request, signal, onProgress) => renderWithSpawn(spawnImpl, workerPath, request, signal, onProgress), verify });
}

module.exports = Object.freeze({ ...createHyperframesProvider(), createHyperframesProvider });
