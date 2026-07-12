const { spawn } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { assertStoragePath } = require("../storage.cjs");

const RENDERER_SCRIPT = resolve(__dirname, "../../renderer/narrated/render-keyframes.mjs");

function renderNarratedKeyframes(input = {}) {
  const timelinePath = assertStoragePath(input.timelinePath, input.timelineArea || "artifacts");
  const draftPath = assertStoragePath(input.draftPath, input.draftArea || "artifacts");
  const outputDir = assertStoragePath(input.outputDir, input.outputArea || "tmp");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      RENDERER_SCRIPT,
      "--timeline", timelinePath,
      "--draft", draftPath,
      "--output", outputDir,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = Number.isInteger(input.timeoutMs) ? input.timeoutMs : 120000;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const abort = () => child.kill("SIGTERM");
    if (input.signal) {
      if (input.signal.aborted) abort();
      else input.signal.addEventListener("abort", abort, { once: true });
    }
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    child.on("error", () => rejectOnce(new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500)));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (input.signal) input.signal.removeEventListener("abort", abort);
      if (input.signal && input.signal.aborted) {
        reject(new AppError("JOB_CANCELLED", SAFE_MESSAGES.JOB_CANCELLED, 409));
        return;
      }
      if (code !== 0) {
        reject(new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500, { phase: "narrated_keyframes", stderr: stderr.slice(-400) }));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim().split(/\r?\n/).pop());
        if (!result.manifestPath || !existsSync(result.manifestPath)) throw new Error("missing manifest");
        const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
        resolvePromise({ ...manifest, manifestPath: result.manifestPath });
      } catch {
        reject(new AppError("RENDER_FAILED", SAFE_MESSAGES.RENDER_FAILED, 500, { phase: "narrated_keyframes" }));
      }
    });
  });
}

module.exports = {
  RENDERER_SCRIPT,
  renderNarratedKeyframes,
};
