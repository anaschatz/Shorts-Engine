import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { compileAnimationIR } = require("../server/pipelines/narrated-short/animation/compiler.cjs");
const provider = require("../server/pipelines/narrated-short/animation/providers/hyperframes.cjs");
const { runBenchmarkQa, writeContactSheet } = require("../server/pipelines/narrated-short/animation/benchmark-qa.cjs");
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE = join(ROOT, "eval/narrated/dark-curiosity/animation/001_wow_signal_benchmark.json");

function argValue(args, name) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; }
function hashFile(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function publicDoctor(report) { return { ready: report.ready, provider: report.provider, runtimeVersion: report.runtimeVersion, nodeVersion: report.nodeVersion, checks: report.checks }; }

function compileFixture(width) {
  const input = JSON.parse(readFileSync(FIXTURE, "utf8"));
  input.width = width;
  input.height = width * 16 / 9;
  return compileAnimationIR(input);
}

async function renderSize(width, outputRoot) {
  const ir = compileFixture(width);
  const runtimeDir = mkdtempSync(join(tmpdir(), `dark-curiosity-animation-${width}-`));
  const stagedOutput = join(runtimeDir, "wow-signal-visual-master.mp4");
  const contactSheet = join(runtimeDir, "wow-signal-contact-sheet.png");
  try {
    const result = await provider.render({ animationIR: ir, stagingDir: runtimeDir, outputName: basename(stagedOutput), timeoutMs: 120000, quality: width === 1080 ? "high" : "standard" }, undefined, (event) => process.stderr.write(`render ${width}: ${Math.round(event.percent * 100)}% ${event.stage}\n`));
    writeContactSheet(stagedOutput, contactSheet);
    const qa = runBenchmarkQa({ outputPath: stagedOutput, width: ir.width, height: ir.height, foregroundMaxY: Math.round(ir.height * 920 / 1280), captionSafeTopRatio: ir.motionBudget.captionSafeZone.topRatio, clippedEntities: 0 });
    if (!qa.passed) throw new Error(`benchmark_qa_failed:${Object.entries(qa.checks).filter(([, passed]) => !passed).map(([name]) => name).join(",")}`);
    const finalDir = join(outputRoot, `${ir.width}x${ir.height}`);
    mkdirSync(finalDir, { recursive: true });
    const finalVideo = join(finalDir, "wow-signal-visual-master.mp4");
    const finalContactSheet = join(finalDir, "wow-signal-contact-sheet.png");
    cpSync(stagedOutput, finalVideo); cpSync(contactSheet, finalContactSheet);
    const manifest = {
      schemaVersion: 1, provider: result.provider, runtimeVersion: result.runtimeVersion, styleSystemVersion: ir.renderer.styleVersion,
      animationIRHash: ir.contentHash, compositionHash: result.compositionHash, outputSha256: hashFile(finalVideo), width: ir.width, height: ir.height,
      fps: qa.technical.fps, frameCount: qa.technical.frameCount, durationSeconds: qa.technical.durationSeconds, codec: qa.technical.codec,
      pixelFormat: qa.technical.pixelFormat, deterministicSeed: ir.seed, sceneFrameRanges: ir.scenes.map(({ id, startFrame, endFrame }) => ({ id, startFrame, endFrame })),
      renderDurationMs: result.renderDurationMs, peakMemoryMb: result.peakMemoryMb, warnings: [], fallbacks: [], continuousMotion: true,
      externalNetworkAllowed: false, sampleEveryFrames: 10, deterministicSampleHashes: qa.samples.sampleHashes, qa,
    };
    const manifestPath = join(finalDir, "visual-master-manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    provider.verify({ ...result, outputPath: finalVideo, outputSha256: manifest.outputSha256 });
    return { manifestPath, videoPath: finalVideo, contactSheetPath: finalContactSheet, metrics: { renderDurationMs: manifest.renderDurationMs, peakMemoryMb: manifest.peakMemoryMb, changedTransitionRatio: qa.samples.changedTransitionRatio, stasisRatio: qa.samples.stasisRatio, motionEnergy: qa.samples.motionEnergy } };
  } finally { rmSync(runtimeDir, { recursive: true, force: true }); }
}

export async function runCli(args = process.argv.slice(2)) {
  const command = args[0] && !args[0].startsWith("--") ? args[0] : "benchmark";
  if (command === "doctor") return publicDoctor(await provider.doctor());
  if (command !== "benchmark") throw new Error("Usage: doctor | benchmark [--dry-run] [--render --yes] [--width 720|1080|both]");
  const render = args.includes("--render"), confirmed = args.includes("--yes");
  const widthOption = argValue(args, "--width") || "both";
  if (render !== confirmed) throw new Error("A real render requires both --render and --yes.");
  const widths = widthOption === "both" ? [720, 1080] : [Number(widthOption)];
  if (widths.some((width) => ![720, 1080].includes(width))) throw new Error("--width must be 720, 1080, or both.");
  const plans = widths.map((width) => { const ir = compileFixture(width); return { width: ir.width, height: ir.height, fps: ir.fps, frames: ir.durationFrames, animationIRHash: ir.contentHash, estimate: provider.estimate({ animationIR: ir }) }; });
  if (!render) return { mode: "dry-run", mutated: false, provider: provider.id, plans };
  const doctor = await provider.doctor();
  if (!doctor.ready) throw new Error("HyperFrames benchmark provider is not ready.");
  const outputRoot = resolve(argValue(args, "--output") || join(ROOT, "data/benchmarks/dark-curiosity-animation/wow-signal"));
  const outputs = [];
  for (const width of widths) outputs.push(await renderSize(width, outputRoot));
  return { mode: "render", provider: provider.id, outputs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { process.stderr.write(`${String(error.message || "Animation benchmark failed.").slice(0, 240)}\n`); process.exitCode = 1; });
