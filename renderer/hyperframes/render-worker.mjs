import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { createRenderJob, executeRenderJob, resolveConfig } from "@hyperframes/producer";
import { compileAnimationIRToHtml } from "./animation-ir-adapter.mjs";
import { hyperframesDoctor } from "./doctor.mjs";

const require = createRequire(import.meta.url);
const { validateAnimationIR } = require("../../server/pipelines/narrated-short/animation/contract.cjs");
const {
  normalizeDraftBundle,
} = require("../../server/pipelines/narrated-short/contracts.cjs");
const {
  normalizeAnimationTimingContext,
} = require("../../server/pipelines/narrated-short/animation/timing-contract.cjs");

const QUIET_LOGGER = Object.freeze({
  error() {},
  warn() {},
  info() {},
  debug() {},
  isLevelEnabled() { return false; },
});

function emit(event) { process.stdout.write(`${JSON.stringify(event)}\n`); }
function inside(root, target) { const rel = relative(resolve(root), resolve(target)); return rel && !rel.startsWith("..") && !rel.includes("/../"); }
function argument(flag) {
  const indexes = process.argv
    .map((value, index) => value === flag ? index : -1)
    .filter((index) => index >= 0);
  const value = indexes.length ? process.argv[indexes[0] + 1] : undefined;
  if (
    indexes.length > 1
    || (
      indexes.length
      && (
        !value
        || value.startsWith("--")
      )
    )
  ) {
    throw new Error("render_source_binding_invalid");
  }
  return value;
}

function validHash(value) {
  return /^[a-f0-9]{64}$/.test(value || "");
}

function validateArgumentGrammar() {
  const args = process.argv.slice(2);
  const generalized = args.includes("--semantic-source-context");
  const expectedFlags = generalized
    ? [
      "--request",
      "--expected-animation-ir-hash",
      "--semantic-source-context",
      "--expected-draft-hash",
      "--expected-timing-context-hash",
    ]
    : ["--request", "--expected-animation-ir-hash"];
  if (
    args.length !== expectedFlags.length * 2
    || expectedFlags.some((flag, index) => (
      args[index * 2] !== flag
      || !args[index * 2 + 1]
      || args[index * 2 + 1].startsWith("--")
    ))
  ) throw new Error("render_source_binding_invalid");
}

async function readBoundedFile(path, maxBytes) {
  const noFollow = Number.isInteger(constants.O_NOFOLLOW)
    ? constants.O_NOFOLLOW
    : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) {
      throw new Error("render_input_invalid");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readAndRemoveJson(path, maxBytes) {
  try {
    return JSON.parse(
      (await readBoundedFile(path, maxBytes)).toString("utf8"),
    );
  } finally {
    await rm(path, { force: true });
  }
}

async function writePrivateFile(path, value) {
  await rm(path, { force: true });
  const noFollow = Number.isInteger(constants.O_NOFOLLOW)
    ? constants.O_NOFOLLOW
    : 0;
  const handle = await open(
    path,
    constants.O_WRONLY
      | constants.O_CREAT
      | constants.O_EXCL
      | noFollow,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(value, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

async function run(privatePaths) {
  validateArgumentGrammar();
  const requestArgument = argument("--request");
  const expectedAnimationIRHash = argument(
    "--expected-animation-ir-hash",
  );
  if (!requestArgument || !validHash(expectedAnimationIRHash)) {
    throw new Error("render_request_missing");
  }
  const sourceContextArgument = argument("--semantic-source-context");
  const expectedDraftHash = argument("--expected-draft-hash");
  const expectedTimingContextHash = argument(
    "--expected-timing-context-hash",
  );
  const sourceArguments = [
    sourceContextArgument,
    expectedDraftHash,
    expectedTimingContextHash,
  ];
  if (
    ![0, 3].includes(sourceArguments.filter(Boolean).length)
    || (
      expectedDraftHash !== undefined
      && (
        !validHash(expectedDraftHash)
        || !validHash(expectedTimingContextHash)
      )
    )
  ) throw new Error("render_source_binding_invalid");
  const requestedPath = resolve(requestArgument);
  const stagingDir = await realpath(dirname(requestedPath));
  const requestPath = resolve(stagingDir, basename(requestedPath));
  privatePaths.add(requestPath);
  privatePaths.add(resolve(stagingDir, "animation-ir.json"));
  privatePaths.add(resolve(stagingDir, "semantic-source-context.json"));
  privatePaths.add(resolve(stagingDir, "index.html"));
  if (
    stagingDir === "/"
    || !basename(stagingDir).startsWith(".hyperframes-render-")
    || basename(requestPath) !== "render-request.json"
  ) throw new Error("render_path_outside_staging");
  const stagingStats = await stat(stagingDir);
  if (
    !stagingStats.isDirectory()
    || (stagingStats.mode & 0o022) !== 0
    || (
      typeof process.getuid === "function"
      && stagingStats.uid !== process.getuid()
    )
  ) throw new Error("render_path_outside_staging");
  const request = await readAndRemoveJson(requestPath, 65_536);
  if (resolve(request.stagingDir || "") !== stagingDir) {
    throw new Error("render_path_outside_staging");
  }
  const irPath = resolve(request.irPath);
  const outputPath = resolve(request.outputPath);
  if (
    irPath !== resolve(stagingDir, "animation-ir.json")
    || dirname(outputPath) !== stagingDir
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.mp4$/.test(
      basename(outputPath),
    )
    || !inside(stagingDir, irPath)
    || !inside(stagingDir, outputPath)
  ) throw new Error("render_path_outside_staging");
  let sourceTrust = {};
  if (sourceContextArgument) {
    const sourceContextPath = resolve(sourceContextArgument);
    if (
      sourceContextPath
        !== resolve(stagingDir, "semantic-source-context.json")
      || !inside(stagingDir, sourceContextPath)
    ) {
      throw new Error("render_source_binding_invalid");
    }
    const sourceContext = await readAndRemoveJson(
      sourceContextPath,
      2_000_000,
    );
    const semanticSourceContext = Object.freeze({
      draft: normalizeDraftBundle(sourceContext.draft),
      timingContext: normalizeAnimationTimingContext(
        sourceContext.timingContext,
      ),
    });
    if (
      semanticSourceContext.draft.contentHash !== expectedDraftHash
      || semanticSourceContext.timingContext.contentHash
        !== expectedTimingContextHash
    ) throw new Error("render_source_binding_invalid");
    sourceTrust = { semanticSourceContext };
  }
  const rawIR = await readAndRemoveJson(irPath, 8_000_000);
  const ir = validateAnimationIR(
    rawIR,
    sourceTrust,
  );
  const generalized = Boolean(
    ir.content?.semanticEventGraph?.primitivePayloadProfileId,
  );
  if (
    ir.contentHash !== expectedAnimationIRHash
    || generalized !== Boolean(sourceContextArgument)
  ) throw new Error("render_source_binding_invalid");
  const composition = compileAnimationIRToHtml(ir, sourceTrust);
  const doctor = await hyperframesDoctor();
  if (!doctor.ready) throw new Error("renderer_not_ready");
  const htmlPath = resolve(stagingDir, "index.html");
  if (!inside(stagingDir, htmlPath)) throw new Error("composition_path_invalid");
  await writePrivateFile(htmlPath, composition.html);
  await rm(outputPath, { force: true });
  const config = resolveConfig({ chromePath: doctor.chromePath, concurrency: 1, forceScreenshot: true, disableGpu: false, browserGpuMode: "software", enableBrowserPool: false, verifyRuntime: true, staticFrameDedup: false, debug: false });
  const job = createRenderJob({ fps: ir.fps, quality: request.quality === "high" ? "high" : "standard", format: "mp4", workers: 1, entryFile: "index.html", producerConfig: config, hdrMode: "force-sdr", logger: QUIET_LOGGER });
  const started = performance.now();
  try {
    await executeRenderJob(job, stagingDir, outputPath, (progressJob, message) => { const raw = Number(progressJob.progress || 0); emit({ type: "progress", stage: String(progressJob.currentStage || "rendering").slice(0, 32), percent: Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw)), message: String(message || "").slice(0, 96) }); });
    const outputSha256 = createHash("sha256")
      .update(await readBoundedFile(outputPath, Number.MAX_SAFE_INTEGER))
      .digest("hex");
    const result = { type: "complete", outputFile: relative(stagingDir, outputPath), outputSha256, animationIRHash: ir.contentHash, compositionHash: composition.compositionHash, renderDurationMs: Math.round(performance.now() - started), peakMemoryMb: job.perfSummary?.peakRssMb ?? null, provider: ir.renderer.provider, runtimeVersion: doctor.runtimeVersion };
    emit(result);
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  } finally {
    await rm(htmlPath, { force: true });
  }
}

async function main() {
  const privatePaths = new Set();
  try {
    await run(privatePaths);
  } finally {
    for (const path of privatePaths) {
      try {
        await rm(path, { force: true });
      } catch {
        // The worker reports only a bounded render failure.
      }
    }
  }
}

main().catch((error) => { emit({ type: "error", code: error?.name === "RenderCancelledError" ? "RENDER_CANCELLED" : "RENDER_FAILED" }); process.exitCode = 1; });
