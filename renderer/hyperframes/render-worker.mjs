import { createHash } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { createRenderJob, executeRenderJob, resolveConfig } from "@hyperframes/producer";
import { compileAnimationIRToHtml } from "./animation-ir-adapter.mjs";
import { hyperframesDoctor } from "./doctor.mjs";

const require = createRequire(import.meta.url);
const { validateAnimationIR } = require("../../server/pipelines/narrated-short/animation/contract.cjs");

function emit(event) { process.stdout.write(`${JSON.stringify(event)}\n`); }
function inside(root, target) { const rel = relative(resolve(root), resolve(target)); return rel && !rel.startsWith("..") && !rel.includes("/../"); }

async function main() {
  const requestIndex = process.argv.indexOf("--request");
  if (requestIndex < 0 || !process.argv[requestIndex + 1]) throw new Error("render_request_missing");
  const requestPath = resolve(process.argv[requestIndex + 1]);
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const stagingDir = resolve(request.stagingDir);
  const irPath = resolve(request.irPath);
  const outputPath = resolve(request.outputPath);
  if (!inside(stagingDir, requestPath) || !inside(stagingDir, irPath) || !inside(stagingDir, outputPath)) throw new Error("render_path_outside_staging");
  const doctor = await hyperframesDoctor();
  if (!doctor.ready) throw new Error("renderer_not_ready");
  const ir = validateAnimationIR(JSON.parse(await readFile(irPath, "utf8")));
  const composition = compileAnimationIRToHtml(ir);
  const htmlPath = resolve(stagingDir, "index.html");
  if (!inside(stagingDir, htmlPath)) throw new Error("composition_path_invalid");
  await writeFile(htmlPath, composition.html, { encoding: "utf8", mode: 0o600 });
  const config = resolveConfig({ chromePath: doctor.chromePath, concurrency: 1, forceScreenshot: true, disableGpu: false, browserGpuMode: "hardware", enableBrowserPool: false, verifyRuntime: true, staticFrameDedup: false, debug: false });
  const job = createRenderJob({ fps: ir.fps, quality: request.quality === "high" ? "high" : "standard", format: "mp4", workers: 1, entryFile: "index.html", producerConfig: config, hdrMode: "force-sdr" });
  const started = performance.now();
  try {
    await executeRenderJob(job, stagingDir, outputPath, (progressJob, message) => { const raw = Number(progressJob.progress || 0); emit({ type: "progress", stage: String(progressJob.currentStage || "rendering").slice(0, 32), percent: Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw)), message: String(message || "").slice(0, 96) }); });
    const outputSha256 = createHash("sha256").update(await readFile(outputPath)).digest("hex");
    const result = { type: "complete", outputFile: relative(stagingDir, outputPath), outputSha256, animationIRHash: ir.contentHash, compositionHash: composition.compositionHash, renderDurationMs: Math.round(performance.now() - started), peakMemoryMb: job.perfSummary?.peakRssMb ?? null, provider: "hyperframes_benchmark", runtimeVersion: doctor.runtimeVersion };
    emit(result);
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }
}

main().catch((error) => { emit({ type: "error", code: error?.name === "RenderCancelledError" ? "RENDER_CANCELLED" : "RENDER_FAILED" }); process.exitCode = 1; });
