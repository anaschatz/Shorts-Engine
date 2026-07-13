import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { compileAnimationIRToHtml } from "../renderer/hyperframes/animation-ir-adapter.mjs";
import { runBrowserSeekProof } from "../renderer/hyperframes/browser-seek-harness.mjs";
import { hyperframesDoctor } from "../renderer/hyperframes/doctor.mjs";

const require = createRequire(import.meta.url);
const { normalizeAnimationTimingContext } = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");
const { compileTimingBoundAnimationIR } = require("../server/pipelines/narrated-short/animation/compiler.cjs");
const { buildTimingTrace } = require("../server/pipelines/narrated-short/animation/timing-proof.cjs");
const { runAdversarialTimingValidation } = require("../server/pipelines/narrated-short/animation/adversarial-timing.cjs");
const { validateBrowserSeekProof } = require("../server/pipelines/narrated-short/animation/browser-seek-proof.cjs");
const { extractCheckpointMetrics, runBenchmarkQa, writeCheckpointContactSheet } = require("../server/pipelines/narrated-short/animation/benchmark-qa.cjs");
const { stableStringify } = require("../server/pipelines/narrated-short/animation/contract.cjs");
const provider = require("../server/pipelines/narrated-short/animation/providers/hyperframes.cjs");

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CONTEXT_PATH = join(ROOT, "eval/narrated/dark-curiosity/animation/002_wow_signal_timing_context.json");
const PLAN_PATH = join(ROOT, "eval/narrated/dark-curiosity/animation/002_wow_signal_semantic_plan.json");
const OUTPUT_ROOT = join(ROOT, "data/benchmarks/dark-curiosity-animation/wow-signal-browser-seek/720x1280");
const SEEK_SEQUENCE = Object.freeze([27, 76, 27, 209, 76, 241, 209, 291, 0, 241, 291]);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function compileProof() {
  const timingContext = normalizeAnimationTimingContext(readJson(CONTEXT_PATH));
  const ir = compileTimingBoundAnimationIR(readJson(PLAN_PATH), timingContext);
  const trace = buildTimingTrace(ir);
  const composition = compileAnimationIRToHtml(ir);
  return { timingContext, ir, trace, composition };
}

function parseArgs(args) {
  const copy = [...args];
  const command = copy[0] && !copy[0].startsWith("--") ? copy.shift() : "proof";
  if (!new Set(["doctor", "proof"]).has(command)) throw new Error("Animation seek usage is: doctor | proof [--dry-run] [--render --yes] [--fixture wow-signal].");
  const allowed = new Set(["--dry-run", "--render", "--yes", "--fixture"]), flags = new Set();
  let fixture = "wow-signal";
  for (let index = 0; index < copy.length; index += 1) {
    const arg = copy[index];
    if (!allowed.has(arg) || flags.has(arg)) throw new Error("Animation seek arguments are invalid.");
    flags.add(arg);
    if (arg === "--fixture") {
      fixture = copy[++index];
      if (!fixture || fixture.startsWith("--")) throw new Error("Animation seek fixture is invalid.");
    }
  }
  if (fixture !== "wow-signal") throw new Error("Only the allowlisted wow-signal browser seek fixture is supported.");
  const render = flags.has("--render"), yes = flags.has("--yes"), dryRun = flags.has("--dry-run");
  if (render !== yes || (dryRun && render)) throw new Error("A real browser seek proof requires both --render and --yes, without --dry-run.");
  return { command, render, dryRun: !render, fixture };
}

function qaFor(videoPath, compiled) {
  return runBenchmarkQa({ outputPath: videoPath, width: compiled.ir.width, height: compiled.ir.height, foregroundMaxY: 920, captionSafeTopRatio: compiled.ir.motionBudget.captionSafeZone.topRatio, clippedEntities: 0 });
}

async function networkProbe(compiled, chromePath) {
  try {
    await runBrowserSeekProof({ html: compiled.composition.html, width: compiled.ir.width, height: compiled.ir.height, fps: compiled.ir.fps, durationFrames: compiled.ir.durationFrames, chromePath, seekSequence: [0, 1], remoteProbe: true });
  } catch (error) {
    const details = error?.details || {};
    return {
      errorCode: error?.code || "BROWSER_EXTERNAL_PROBE_FAILED",
      externalRequestCount: Number(details.externalRequestCount || 0),
      blockedExternalRequestCount: Number(details.blockedExternalRequestCount || 0),
      resourceClasses: Array.isArray(details.resourceClasses) ? details.resourceClasses : [],
      passed: error?.code === "BROWSER_EXTERNAL_REQUEST_BLOCKED" && details.externalRequestCount >= 1 && details.externalRequestCount === details.blockedExternalRequestCount,
    };
  }
  return { errorCode: "BROWSER_EXTERNAL_PROBE_FAILED", externalRequestCount: 0, blockedExternalRequestCount: 0, resourceClasses: [], passed: false };
}

async function renderOnce(compiled, root, label, chromePath) {
  const stagingDir = join(root, label);
  mkdirSync(stagingDir, { recursive: true });
  const outputPath = join(stagingDir, `wow-signal-browser-seek-${label}.mp4`);
  const render = await provider.render({ animationIR: compiled.ir, stagingDir, outputName: basename(outputPath), timeoutMs: 120000, quality: "standard" }, undefined, (event) => process.stderr.write(`browser seek ${label}: ${Math.round(event.percent * 100)}% ${event.stage}\n`));
  const qa = qaFor(outputPath, compiled);
  if (!qa.passed) throw new Error("BROWSER_SEEK_RENDER_QA_FAILED");
  const checkpoints = extractCheckpointMetrics(outputPath, compiled.trace.checkpoints.map((checkpoint) => checkpoint.frame));
  const browser = await runBrowserSeekProof({ html: compiled.composition.html, width: compiled.ir.width, height: compiled.ir.height, fps: compiled.ir.fps, durationFrames: compiled.ir.durationFrames, chromePath, seekSequence: SEEK_SEQUENCE });
  if (!browser.passed || browser.repeatedFrames.length < 5) throw new Error("BROWSER_RANDOM_ACCESS_NONDETERMINISTIC");
  provider.verify({ ...render, outputPath });
  return { outputPath, render, qa, checkpoints, browser };
}

function compareRuns(compiled, first, second) {
  const equal = (a, b) => stableStringify(a) === stableStringify(b);
  const repeatRender = {
    timingContextHashEqual: first.render.animationIRHash === second.render.animationIRHash && compiled.timingContext.contentHash === compiled.ir.timingBinding.timingContextHash,
    animationIRHashEqual: first.render.animationIRHash === second.render.animationIRHash && first.render.animationIRHash === compiled.ir.contentHash,
    compositionHashEqual: first.render.compositionHash === second.render.compositionHash && first.render.compositionHash === compiled.composition.compositionHash,
    checkpointHashesEqual: equal(first.checkpoints.sampleHashes, second.checkpoints.sampleHashes),
    browserSeekHashesEqual: equal(first.browser.captures, second.browser.captures),
    technicalMetadataEqual: equal(first.qa.technical, second.qa.technical),
    mp4Sha256Equal: first.render.outputSha256 === second.render.outputSha256,
    firstOutputSha256: first.render.outputSha256,
    secondOutputSha256: second.render.outputSha256,
  };
  repeatRender.passed = [repeatRender.timingContextHashEqual, repeatRender.animationIRHashEqual, repeatRender.compositionHashEqual, repeatRender.checkpointHashesEqual, repeatRender.browserSeekHashesEqual, repeatRender.technicalMetadataEqual].every(Boolean);
  return repeatRender;
}

async function renderProof(compiled) {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "dark-curiosity-browser-seek-"));
  try {
    const doctor = await hyperframesDoctor();
    if (!doctor.ready || !doctor.chromePath) throw new Error("BROWSER_SEEK_PROVIDER_NOT_READY");
    const probe = await networkProbe(compiled, doctor.chromePath);
    if (!probe.passed) throw new Error("BROWSER_EXTERNAL_PROBE_FAILED");
    const adversarial = runAdversarialTimingValidation({ plan: readJson(PLAN_PATH), timingContext: readJson(CONTEXT_PATH), artifactDirectory: runtimeRoot });
    if (!adversarial.passed) throw new Error("BROWSER_ADVERSARIAL_TIMING_FAILED");
    const first = await renderOnce(compiled, runtimeRoot, "a", doctor.chromePath);
    const second = await renderOnce(compiled, runtimeRoot, "b", doctor.chromePath);
    const repeatRender = compareRuns(compiled, first, second);
    if (!repeatRender.passed) throw new Error("BROWSER_REPEAT_RENDER_NONDETERMINISTIC");
    const proof = validateBrowserSeekProof({
      schemaVersion: 1,
      profile: "dark_curiosity_browser_seek_proof_v1",
      animationIRHash: compiled.ir.contentHash,
      timingContextHash: compiled.timingContext.contentHash,
      compositionHash: compiled.composition.compositionHash,
      provider: first.render.provider,
      runtimeVersion: first.render.runtimeVersion,
      styleSystemVersion: compiled.ir.renderer.styleVersion,
      templateVersions: Object.fromEntries(compiled.ir.scenes.map((scene) => [scene.template, scene.templateVersion])),
      seekSequence: first.browser.seekSequence,
      captures: first.browser.captures,
      repeatedFrames: first.browser.repeatedFrames,
      browser: {
        loadedOnce: first.browser.loadedOnce,
        pageLoadCount: first.browser.pageLoadCount,
        stateIsolation: first.browser.stateIsolation,
        externalRequestCount: first.browser.externalRequestCount,
        blockedExternalRequestCount: first.browser.blockedExternalRequestCount,
        resourceClasses: first.browser.resourceClasses,
      },
      networkProbe: probe,
      adversarial,
      repeatRender,
      passed: true,
      warnings: repeatRender.mp4Sha256Equal ? [] : ["container_hash_differs"],
    });
    mkdirSync(OUTPUT_ROOT, { recursive: true });
    const firstOutput = join(OUTPUT_ROOT, "wow-signal-browser-seek-proof-a.mp4");
    const secondOutput = join(OUTPUT_ROOT, "wow-signal-browser-seek-proof-b.mp4");
    const sheet = join(OUTPUT_ROOT, "wow-signal-browser-seek-checkpoints.png");
    const manifest = join(OUTPUT_ROOT, "browser-seek-proof-manifest.json");
    cpSync(first.outputPath, firstOutput); cpSync(second.outputPath, secondOutput);
    writeCheckpointContactSheet(firstOutput, sheet, compiled.trace.checkpoints.map((checkpoint) => checkpoint.frame));
    writeFileSync(manifest, `${JSON.stringify(proof, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return {
      firstOutput, secondOutput, contactSheet: sheet, manifest,
      metrics: {
        firstRenderDurationMs: first.render.renderDurationMs,
        secondRenderDurationMs: second.render.renderDurationMs,
        firstPeakMemoryMb: first.render.peakMemoryMb,
        secondPeakMemoryMb: second.render.peakMemoryMb,
        firstStasisRatio: first.qa.samples.stasisRatio,
        secondStasisRatio: second.qa.samples.stasisRatio,
        repeatedFrameCount: proof.repeatedFrames.length,
        externalRequestCount: proof.browser.externalRequestCount,
        blockedProbeRequestCount: proof.networkProbe.blockedExternalRequestCount,
        adversarialCaseCount: proof.adversarial.caseCount,
        mp4Sha256Equal: proof.repeatRender.mp4Sha256Equal,
        proofHash: proof.contentHash,
      },
    };
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

export async function runSeekCli(args = process.argv.slice(2)) {
  const parsed = parseArgs(args);
  const compiled = compileProof();
  if (parsed.command === "doctor") {
    const report = await provider.doctor();
    return { ...report, semanticTimingValid: true, compositionIsolationValid: true, fixture: parsed.fixture };
  }
  const adversarial = runAdversarialTimingValidation({ plan: readJson(PLAN_PATH), timingContext: readJson(CONTEXT_PATH) });
  const repeated = compileProof();
  if (!parsed.render) return { mode: "dry-run", mutated: false, fixture: parsed.fixture, animationIRHash: compiled.ir.contentHash, timingContextHash: compiled.timingContext.contentHash, compositionHash: compiled.composition.compositionHash, deterministicCompilation: compiled.ir.contentHash === repeated.ir.contentHash && compiled.composition.compositionHash === repeated.composition.compositionHash, seekSequence: SEEK_SEQUENCE, adversarial, estimate: provider.estimate({ animationIR: compiled.ir }) };
  return { mode: "render", fixture: parsed.fixture, provider: provider.id, output: await renderProof(compiled) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runSeekCli().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { process.stderr.write(`Animation browser seek proof failed safely (${String(error?.code || error?.message || "UNKNOWN").replace(/[^A-Z0-9_]/gi, "_").slice(0, 80)}).\n`); process.exitCode = 1; });
