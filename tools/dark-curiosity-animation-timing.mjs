import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createPathMorph } from "../renderer/hyperframes/primitives/path-morph.mjs";

const require = createRequire(import.meta.url);
const { normalizeAnimationTimingContext } = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");
const { compileTimingBoundAnimationIR } = require("../server/pipelines/narrated-short/animation/compiler.cjs");
const { buildTimingTrace, validateTimingTrace } = require("../server/pipelines/narrated-short/animation/timing-proof.cjs");
const { extractCheckpointMetrics, extractRangeMotion, runBenchmarkQa, writeCheckpointContactSheet } = require("../server/pipelines/narrated-short/animation/benchmark-qa.cjs");
const provider = require("../server/pipelines/narrated-short/animation/providers/hyperframes.cjs");

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CONTEXT_PATH = join(ROOT, "eval/narrated/dark-curiosity/animation/002_wow_signal_timing_context.json");
const PLAN_PATH = join(ROOT, "eval/narrated/dark-curiosity/animation/002_wow_signal_semantic_plan.json");
const OUTPUT_ROOT = join(ROOT, "data/benchmarks/dark-curiosity-animation/wow-signal-timing/720x1280");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hashFile = (path) => sha256(readFileSync(path));

function compileProof() {
  const timingContext = normalizeAnimationTimingContext(readJson(CONTEXT_PATH));
  const ir = compileTimingBoundAnimationIR(readJson(PLAN_PATH), timingContext);
  return { timingContext, ir, trace: buildTimingTrace(ir) };
}

function alignmentSensitivity(baseline) {
  const changedInput = readJson(CONTEXT_PATH); delete changedInput.contentHash;
  changedInput.words[2].startFrame += 2;
  const changed = normalizeAnimationTimingContext(changedInput);
  const changedIr = compileTimingBoundAnimationIR(readJson(PLAN_PATH), changed);
  const baselineWave = baseline.ir.scenes[0].operations.find((item) => item.op === "draw_path" && item.targetId === "signal_wave");
  const changedWave = changedIr.scenes[0].operations.find((item) => item.op === "draw_path" && item.targetId === "signal_wave");
  return { changed: baseline.ir.contentHash !== changedIr.contentHash, baselineIRHash: baseline.ir.contentHash, changedIRHash: changedIr.contentHash, dependentCheckpoint: { baselineFrame: baselineWave.from.resolvedFrame, changedFrame: changedWave.from.resolvedFrame }, independentMorphStartUnchanged: baseline.ir.scenes[0].operations.find((item) => item.op === "morph_path").from.resolvedFrame === changedIr.scenes[0].operations.find((item) => item.op === "morph_path").from.resolvedFrame };
}

function backwardSeekProof() {
  const morph = createPathMorph();
  const first = morph.pathAt(0.273), later = morph.pathAt(0.91), repeated = morph.pathAt(0.273);
  return { passed: first === repeated && first !== later, firstStateHash: sha256(first), laterStateHash: sha256(later), repeatedStateHash: sha256(repeated), pointCount: morph.pointCount };
}

async function renderProof(compiled) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "dark-curiosity-timing-proof-"));
  const stagedSheet = join(runtimeDir, "wow-signal-timing-checkpoints.png");
  try {
    const result = await provider.render({ animationIR: compiled.ir, stagingDir: runtimeDir, outputName: "wow-signal-timing-proof.mp4", timeoutMs: 120000, quality: "standard" }, undefined, (event) => process.stderr.write(`timing proof: ${Math.round(event.percent * 100)}% ${event.stage}\n`));
    provider.verify(result);
    const stagedVideo = result.outputPath;
    const checkpointFrames = compiled.trace.checkpoints.map((item) => item.frame);
    writeCheckpointContactSheet(stagedVideo, stagedSheet, checkpointFrames);
    const qa = runBenchmarkQa({ outputPath: stagedVideo, width: 720, height: 1280, foregroundMaxY: 920, captionSafeTopRatio: compiled.ir.motionBudget.captionSafeZone.topRatio, clippedEntities: 0 });
    const checkpointMetrics = extractCheckpointMetrics(stagedVideo, checkpointFrames);
    const morph = compiled.ir.scenes[0].operations.find((item) => item.op === "morph_path" && item.targetId === "signal_wave");
    const hold = compiled.ir.scenes[1].readabilityHolds[0];
    const activeMotion = extractRangeMotion(stagedVideo, morph.from.resolvedFrame, morph.to.resolvedFrame);
    const holdMotion = extractRangeMotion(stagedVideo, hold.startFrame, hold.endFrame - 1);
    const timingChecks = {
      allOperationsResolved: compiled.trace.resolvedOperationCount === compiled.ir.scenes.reduce((count, scene) => count + scene.operations.length, 0),
      checkpointCount: checkpointMetrics.sampleCount === compiled.trace.checkpoints.length,
      checkpointDiversity: checkpointMetrics.uniqueFrameRatio === 1,
      morphChanges: checkpointMetrics.sampleHashes[4] !== checkpointMetrics.sampleHashes[3] && checkpointMetrics.sampleHashes[4] !== checkpointMetrics.sampleHashes[5],
      readabilityHoldLowerMotion: holdMotion.motionEnergy < activeMotion.motionEnergy,
      backwardSeekDeterministic: backwardSeekProof().passed,
      alignmentSensitive: alignmentSensitivity(compiled).changed,
    };
    if (!qa.passed || !Object.values(timingChecks).every(Boolean)) throw new Error(`timing_proof_qa_failed:${Object.entries({ ...qa.checks, ...timingChecks }).filter(([, passed]) => !passed).map(([key]) => key).join(",")}`);
    mkdirSync(OUTPUT_ROOT, { recursive: true });
    const videoPath = join(OUTPUT_ROOT, "wow-signal-timing-proof.mp4");
    const contactSheetPath = join(OUTPUT_ROOT, "wow-signal-timing-checkpoints.png");
    cpSync(stagedVideo, videoPath); cpSync(stagedSheet, contactSheetPath);
    const manifest = {
      schemaVersion: 1, provider: result.provider, runtimeVersion: result.runtimeVersion, styleSystemVersion: compiled.ir.renderer.styleVersion,
      animationIRHash: compiled.ir.contentHash, compositionHash: result.compositionHash, outputSha256: hashFile(videoPath),
      width: 720, height: 1280, fps: qa.technical.fps, frameCount: qa.technical.frameCount, durationSeconds: qa.technical.durationSeconds,
      codec: qa.technical.codec, pixelFormat: qa.technical.pixelFormat, deterministicSeed: compiled.ir.seed,
      renderDurationMs: result.renderDurationMs, peakMemoryMb: result.peakMemoryMb, continuousMotion: true, externalNetworkAllowed: false,
      timingTrace: compiled.trace, timingChecks, checkpointHashes: Object.fromEntries(compiled.trace.checkpoints.map((item, index) => [item.id, checkpointMetrics.sampleHashes[index]])),
      motionRanges: { activeMorphEnergy: activeMotion.motionEnergy, readabilityHoldEnergy: holdMotion.motionEnergy },
      backwardSeekProof: backwardSeekProof(), alignmentSensitivity: alignmentSensitivity(compiled), qa,
      warnings: [], fallbacks: [],
    };
    validateTimingTrace(manifest.timingTrace, compiled.ir);
    const manifestPath = join(OUTPUT_ROOT, "timing-proof-manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    if (manifest.outputSha256 !== result.outputSha256) throw new Error("timing_proof_output_copy_mismatch");
    return { videoPath, contactSheetPath, manifestPath, metrics: { renderDurationMs: result.renderDurationMs, peakMemoryMb: result.peakMemoryMb, changedTransitionRatio: qa.samples.changedTransitionRatio, stasisRatio: qa.samples.stasisRatio, activeMorphEnergy: activeMotion.motionEnergy, readabilityHoldEnergy: holdMotion.motionEnergy } };
  } finally { rmSync(runtimeDir, { recursive: true, force: true }); }
}

export async function runTimingCli(args = process.argv.slice(2)) {
  const command = args[0] && !args[0].startsWith("--") ? args[0] : "proof";
  const fixtureIndex = args.indexOf("--fixture");
  if (fixtureIndex >= 0 && args[fixtureIndex + 1] !== "wow-signal") throw new Error("Only the allowlisted wow-signal timing fixture is supported.");
  const compiled = compileProof();
  if (command === "doctor") return { ...(await provider.doctor()), timingContextValid: true, semanticPlanValid: true, timingContextHash: compiled.timingContext.contentHash };
  if (command !== "proof") throw new Error("Usage: doctor | proof [--dry-run] [--render --yes] [--fixture wow-signal]");
  const render = args.includes("--render"), yes = args.includes("--yes");
  if (render !== yes) throw new Error("A real timing proof requires both --render and --yes.");
  const repeated = compileProof();
  const dry = { mode: "dry-run", mutated: false, animationIRHash: compiled.ir.contentHash, deterministicCompilation: compiled.ir.contentHash === repeated.ir.contentHash, timingTrace: compiled.trace, backwardSeekProof: backwardSeekProof(), alignmentSensitivity: alignmentSensitivity(compiled), estimate: provider.estimate({ animationIR: compiled.ir }) };
  if (!render) return dry;
  const doctor = await provider.doctor();
  if (!doctor.ready) throw new Error("HyperFrames timing proof provider is not ready.");
  return { mode: "render", provider: provider.id, output: await renderProof(compiled) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runTimingCli().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { process.stderr.write(`${String(error.message || "Animation timing proof failed.").slice(0, 240)}\n`); process.exitCode = 1; });
