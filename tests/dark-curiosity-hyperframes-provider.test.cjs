const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs");
const { basename, dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");
const { compileAnimationIR } = require("../server/pipelines/narrated-short/animation/compiler.cjs");
const {
  normalizeDraftBundle,
} = require("../server/pipelines/narrated-short/contracts.cjs");
const {
  compileProductionAnimation,
} = require("../server/pipelines/narrated-short/animation/production-plan-compiler.cjs");
const {
  normalizeAnimationTimingContext,
} = require("../server/pipelines/narrated-short/animation/timing-contract.cjs");
const hyperframes = require("../server/pipelines/narrated-short/animation/providers/hyperframes.cjs");

function irFixture() {
  return compileAnimationIR(JSON.parse(readFileSync(join(__dirname, "../eval/narrated/dark-curiosity/animation/001_wow_signal_benchmark.json"), "utf8")));
}

function fakeChild(onKill = null) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { onKill?.(); process.nextTick(() => child.emit("close", null)); return true; };
  return child;
}

function generalizedFixture() {
  const raw = JSON.parse(readFileSync(join(
    __dirname,
    "../eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json",
  ), "utf8"));
  const draft = normalizeDraftBundle(raw);
  let frame = 0;
  let wordIndex = 0;
  const words = [];
  const beats = [];
  for (const beat of draft.script.beats) {
    const wordStartIndex = wordIndex;
    for (const text of beat.spokenText.split(/\s+/).filter(Boolean)) {
      words.push({
        index: wordIndex,
        text,
        startFrame: frame,
        endFrame: frame + 6,
      });
      wordIndex += 1;
      frame += 8;
    }
    beats.push({
      beatId: beat.id,
      wordStartIndex,
      wordEndIndex: wordIndex,
      startFrame: words[wordStartIndex].startFrame,
      endFrame: words[wordIndex - 1].endFrame,
    });
    frame += 16;
  }
  const timingContext = normalizeAnimationTimingContext({
    schemaVersion: 1,
    fps: 30,
    durationFrames: frame + 30,
    alignmentHash: createHash("sha256")
      .update(`provider-source-trust:${draft.contentHash}`)
      .digest("hex"),
    draftHash: draft.contentHash,
    words,
    beats,
  });
  return {
    draft,
    timingContext,
    animationIR: compileProductionAnimation({
      animationProfile: "semantic-v3",
      projectId: "prj_provider_source_trust",
      projectRevision: 1,
      renderProfile: "preview",
      draft,
      timingContext,
    }).animationIR,
  };
}

test("HyperFrames doctor reports pinned local runtime without secrets", async () => {
  const report = await hyperframes.doctor();
  assert.equal(report.runtimeVersion, "0.7.55");
  assert.equal(report.ready, true);
  assert.equal("chromePath" in report, false);
});

test("engine-owned composition is deterministic and blocks remote runtime", async () => {
  const { compileAnimationIRToHtml } = await import("../renderer/hyperframes/animation-ir-adapter.mjs");
  const first = compileAnimationIRToHtml(irFixture());
  const second = compileAnimationIRToHtml(irFixture());
  assert.equal(first.compositionHash, second.compositionHash);
  assert.match(first.html, /connect-src 'none'/);
  assert.doesNotMatch(first.html, /https?:\/\/|Math\.random|\bgsap\b/i);
  assert.match(first.html, /data-caption-safe-zone="true"/);
  assert.match(first.html, /@font-face\{font-family:"Outfit";src:url\(data:font\/woff2;base64,/);
  assert.match(first.html, /data-font-sha256="8cfe15c2c6de6ef8efff3eedbd52a383ac9ef23d6c23f6cd9f9b838f5f37dc36"/);
  assert.doesNotMatch(first.html, /textLength=|lengthAdjust=/);
});

test("render worker uses software browser rasterization for bitwise-stable frames", () => {
  const worker = readFileSync(join(__dirname, "../renderer/hyperframes/render-worker.mjs"), "utf8");
  assert.match(worker, /browserGpuMode:\s*"software"/);
  assert.doesNotMatch(worker, /browserGpuMode:\s*"hardware"/);
});

test("render worker bounds upstream diagnostics instead of overflowing the provider stderr budget", () => {
  const worker = readFileSync(join(__dirname, "../renderer/hyperframes/render-worker.mjs"), "utf8");
  assert.match(worker, /const QUIET_LOGGER = Object\.freeze/);
  assert.match(worker, /isLevelEnabled\(\) \{ return false; \}/);
  assert.match(worker, /logger:\s*QUIET_LOGGER/);
  assert.match(worker, /function argument\(flag\)/);
  assert.match(worker, /function validateArgumentGrammar\(\)/);
  assert.match(worker, /indexes\.length > 1/);
  assert.match(worker, /--semantic-source-context/);
  assert.match(worker, /--expected-animation-ir-hash/);
  assert.match(worker, /--expected-draft-hash/);
  assert.match(worker, /--expected-timing-context-hash/);
  assert.match(worker, /readBoundedFile\(path, maxBytes\)/);
  assert.match(worker, /2_000_000/);
  assert.match(worker, /8_000_000/);
  assert.match(worker, /ir\.contentHash !== expectedAnimationIRHash/);
  assert.doesNotMatch(worker, /request\.trustedSemanticEventGraphHash/);
  assert.doesNotMatch(worker, /request\.semanticSourceContext/);
});

test("provider transports approved generalized source context out of band", async () => {
  const fixture = generalizedFixture();
  const graphHash = fixture.animationIR.content.semanticEventGraph.contentHash;
  let workerArgs = null;
  let requestBody = null;
  let sourceContextBody = null;
  const provider = hyperframes.createHyperframesProvider({
    providerId: "hyperframes_local",
    spawnImpl(_command, args) {
      workerArgs = args;
      const requestIndex = args.indexOf("--request");
      requestBody = JSON.parse(readFileSync(args[requestIndex + 1], "utf8"));
      const sourceContextIndex = args.indexOf("--semantic-source-context");
      sourceContextBody = JSON.parse(
        readFileSync(args[sourceContextIndex + 1], "utf8"),
      );
      const child = fakeChild();
      process.nextTick(() => child.emit("close", 1));
      return child;
    },
  });
  assert.throws(
    () => provider.validate(fixture.animationIR),
    /trusted validation context/,
  );
  assert.throws(
    () => provider.validate(fixture.animationIR, {
      trustedSemanticEventGraphHash: graphHash,
    }),
    /trusted validation context/,
  );
  const validated = provider.validate(fixture.animationIR, {
    semanticSourceContext: {
      draft: fixture.draft,
      timingContext: fixture.timingContext,
    },
  });
  assert.equal(validated.sourceValidatedSemanticEventGraphHash, graphHash);
  assert.equal(
    provider.estimate(validated).frames,
    fixture.animationIR.durationFrames,
  );
  const stagingDir = mkdtempSync(join(tmpdir(), "hf-source-trust-"));
  await assert.rejects(
    provider.render({
      validated: {
        animationIR: fixture.animationIR,
        sourceValidatedSemanticEventGraphHash: graphHash,
      },
      stagingDir,
    }),
    { code: "ANIMATION_SOURCE_BINDING_INVALID" },
  );
  await assert.rejects(
    provider.render({ validated, stagingDir, timeoutMs: 2000 }),
    { code: "ANIMATION_RENDER_FAILED" },
  );
  const sourceContextIndex = workerArgs.indexOf(
    "--semantic-source-context",
  );
  const animationIRHashIndex = workerArgs.indexOf(
    "--expected-animation-ir-hash",
  );
  const draftHashIndex = workerArgs.indexOf("--expected-draft-hash");
  const timingHashIndex = workerArgs.indexOf(
    "--expected-timing-context-hash",
  );
  assert.ok(sourceContextIndex > 0);
  assert.ok(animationIRHashIndex > 0);
  assert.ok(draftHashIndex > sourceContextIndex);
  assert.ok(timingHashIndex > draftHashIndex);
  assert.equal(
    workerArgs[animationIRHashIndex + 1],
    fixture.animationIR.contentHash,
  );
  assert.equal(workerArgs[draftHashIndex + 1], fixture.draft.contentHash);
  assert.equal(
    workerArgs[timingHashIndex + 1],
    fixture.timingContext.contentHash,
  );
  assert.equal(sourceContextBody.draft.contentHash, fixture.draft.contentHash);
  assert.equal(
    sourceContextBody.timingContext.contentHash,
    fixture.timingContext.contentHash,
  );
  assert.equal("trustedSemanticEventGraphHash" in requestBody, false);
  assert.equal("sourceValidatedSemanticEventGraphHash" in requestBody, false);
  assert.equal("semanticSourceContext" in requestBody, false);
  assert.ok([
    realpathSync(stagingDir),
    realpathSync(tmpdir()),
  ].includes(dirname(requestBody.stagingDir)));
  assert.match(
    basename(requestBody.stagingDir),
    /^\.hyperframes-render-/,
  );
  assert.equal(existsSync(requestBody.stagingDir), false);
  for (const name of [
    "animation-ir.json",
    "render-request.json",
    "semantic-source-context.json",
    "index.html",
  ]) {
    assert.equal(existsSync(join(stagingDir, name)), false);
  }
  assert.deepEqual(readdirSync(stagingDir), []);
});

test("worker rejects duplicate arguments and a substituted staged IR", () => {
  const workerPath = join(
    __dirname,
    "../renderer/hyperframes/render-worker.mjs",
  );
  const duplicate = spawnSync(process.execPath, [
    workerPath,
    "--request",
    "first.json",
    "--request",
    "second.json",
    "--expected-animation-ir-hash",
    "a".repeat(64),
  ], { encoding: "utf8" });
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stdout, /"type":"error"/);

  const unknown = spawnSync(process.execPath, [
    workerPath,
    "--request",
    "first.json",
    "--expected-animation-ir-hash",
    "a".repeat(64),
    "--unexpected",
    "value",
  ], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stdout, /"type":"error"/);

  const stagingDir = realpathSync(
    mkdtempSync(join(tmpdir(), ".hyperframes-render-")),
  );
  const requestPath = join(stagingDir, "render-request.json");
  const irPath = join(stagingDir, "animation-ir.json");
  const outputPath = join(stagingDir, "visual-master.mp4");
  writeFileSync(irPath, JSON.stringify(irFixture()), { mode: 0o600 });
  writeFileSync(requestPath, JSON.stringify({
    stagingDir,
    irPath,
    outputPath,
    quality: "standard",
  }), { mode: 0o600 });
  const substituted = spawnSync(process.execPath, [
    workerPath,
    "--request",
    requestPath,
    "--expected-animation-ir-hash",
    "b".repeat(64),
  ], { encoding: "utf8" });
  assert.equal(substituted.status, 1);
  assert.match(substituted.stdout, /"type":"error"/);
  assert.equal(existsSync(requestPath), false);
  assert.equal(existsSync(irPath), false);
  assert.equal(existsSync(outputPath), false);
});

test("worker rejects mismatched and symlinked generalized source context", () => {
  const workerPath = join(
    __dirname,
    "../renderer/hyperframes/render-worker.mjs",
  );
  const fixture = generalizedFixture();
  const stage = (sourceWriter) => {
    const stagingDir = realpathSync(
      mkdtempSync(join(tmpdir(), ".hyperframes-render-")),
    );
    const requestPath = join(stagingDir, "render-request.json");
    const irPath = join(stagingDir, "animation-ir.json");
    const sourceContextPath = join(
      stagingDir,
      "semantic-source-context.json",
    );
    const outputPath = join(stagingDir, "visual-master.mp4");
    writeFileSync(irPath, JSON.stringify(fixture.animationIR), { mode: 0o600 });
    writeFileSync(requestPath, JSON.stringify({
      stagingDir,
      irPath,
      outputPath,
      quality: "standard",
    }), { mode: 0o600 });
    sourceWriter(sourceContextPath);
    return {
      stagingDir,
      requestPath,
      irPath,
      sourceContextPath,
      outputPath,
    };
  };
  const run = (staged, draftHash = fixture.draft.contentHash) => (
    spawnSync(process.execPath, [
      workerPath,
      "--request",
      staged.requestPath,
      "--expected-animation-ir-hash",
      fixture.animationIR.contentHash,
      "--semantic-source-context",
      staged.sourceContextPath,
      "--expected-draft-hash",
      draftHash,
      "--expected-timing-context-hash",
      fixture.timingContext.contentHash,
    ], { encoding: "utf8" })
  );
  const assertCleanFailure = (result, staged) => {
    assert.equal(result.status, 1);
    assert.match(result.stdout, /"type":"error"/);
    for (const path of [
      staged.requestPath,
      staged.irPath,
      staged.sourceContextPath,
      staged.outputPath,
    ]) assert.equal(existsSync(path), false);
  };

  const mismatched = stage((sourceContextPath) => {
    writeFileSync(sourceContextPath, JSON.stringify({
      draft: fixture.draft,
      timingContext: fixture.timingContext,
    }), { mode: 0o600 });
  });
  assertCleanFailure(run(mismatched, "e".repeat(64)), mismatched);

  const targetPath = join(
    mkdtempSync(join(tmpdir(), "hf-worker-context-target-")),
    "source.json",
  );
  const targetBody = JSON.stringify({
    draft: fixture.draft,
    timingContext: fixture.timingContext,
  });
  writeFileSync(targetPath, targetBody, { mode: 0o600 });
  const symlinked = stage((sourceContextPath) => {
    symlinkSync(targetPath, sourceContextPath);
  });
  assertCleanFailure(run(symlinked), symlinked);
  assert.equal(readFileSync(targetPath, "utf8"), targetBody);
});

test("provider isolates each render without following root staging symlinks", async () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "hf-symlink-"));
  const targetPath = join(
    mkdtempSync(join(tmpdir(), "hf-symlink-target-")),
    "target.json",
  );
  writeFileSync(targetPath, "outside-staging");
  symlinkSync(targetPath, join(stagingDir, "animation-ir.json"));
  const provider = hyperframes.createHyperframesProvider({
    spawnImpl() {
      const child = fakeChild();
      process.nextTick(() => child.emit("close", 1));
      return child;
    },
  });
  await assert.rejects(
    provider.render({
      animationIR: irFixture(),
      stagingDir,
      timeoutMs: 2000,
    }),
    { code: "ANIMATION_RENDER_FAILED" },
  );
  assert.equal(readFileSync(targetPath, "utf8"), "outside-staging");
  assert.equal(lstatSync(join(stagingDir, "animation-ir.json")).isSymbolicLink(), true);
});

test("provider binds worker completion to the validated IR", async () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "hf-complete-binding-"));
  let jobOutputPath = null;
  const provider = hyperframes.createHyperframesProvider({
    spawnImpl(_command, args) {
      const requestIndex = args.indexOf("--request");
      const request = JSON.parse(
        readFileSync(args[requestIndex + 1], "utf8"),
      );
      jobOutputPath = request.outputPath;
      const child = fakeChild();
      process.nextTick(() => {
        const output = "rendered-video";
        writeFileSync(jobOutputPath, output);
        child.stdout.write(`${JSON.stringify({
          type: "complete",
          outputFile: "visual-master.mp4",
          outputSha256: createHash("sha256").update(output).digest("hex"),
          animationIRHash: "c".repeat(64),
          compositionHash: "d".repeat(64),
        })}\n`);
        child.emit("close", 0);
      });
      return child;
    },
  });
  await assert.rejects(
    provider.render({
      animationIR: irFixture(),
      stagingDir,
      timeoutMs: 2000,
    }),
    { code: "ANIMATION_RENDER_FAILED" },
  );
  assert.equal(existsSync(jobOutputPath), false);
  assert.deepEqual(readdirSync(stagingDir), []);
});

test("provider preserves only allowlisted worker failure stages", async () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "hf-safe-stage-"));
  const provider = hyperframes.createHyperframesProvider({
    spawnImpl() {
      const child = fakeChild();
      process.nextTick(() => {
        child.stdout.write(`${JSON.stringify({
          type: "error",
          code: "RENDER_FAILED",
          stage: "composition_compile",
          rawPath: "/private/must-not-pass",
        })}\n`);
        child.emit("close", 1);
      });
      return child;
    },
  });
  await assert.rejects(
    provider.render({
      animationIR: irFixture(),
      stagingDir,
      timeoutMs: 2000,
    }),
    (error) => (
      error.code === "ANIMATION_RENDER_FAILED"
      && error.details?.workerStage === "composition_compile"
      && !JSON.stringify(error).includes("/private/must-not-pass")
    ),
  );
  assert.deepEqual(readdirSync(stagingDir), []);
});

test("provider maps synchronous spawn failures and cleans private inputs", async () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "hf-spawn-error-"));
  const provider = hyperframes.createHyperframesProvider({
    spawnImpl() {
      throw new Error(`private:${stagingDir}`);
    },
  });
  await assert.rejects(
    provider.render({
      animationIR: irFixture(),
      stagingDir,
      timeoutMs: 2000,
    }),
    (error) => (
      error.code === "ANIMATION_RENDER_FAILED"
      && error.details?.renderStage === "worker_spawn"
      && !error.message.includes(stagingDir)
    ),
  );
  for (const name of [
    "animation-ir.json",
    "render-request.json",
    "semantic-source-context.json",
  ]) {
    assert.equal(existsSync(join(stagingDir, name)), false);
  }
});

test("provider maps child failures safely and cleans partial output", async () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "hf-failure-"));
  let jobOutputPath = null;
  const provider = hyperframes.createHyperframesProvider({ spawnImpl(_command, args) {
    const requestIndex = args.indexOf("--request");
    jobOutputPath = JSON.parse(
      readFileSync(args[requestIndex + 1], "utf8"),
    ).outputPath;
    const child = fakeChild();
    process.nextTick(() => { writeFileSync(jobOutputPath, "partial"); child.stderr.write("private local path"); child.emit("close", 1); });
    return child;
  } });
  await assert.rejects(provider.render({ animationIR: irFixture(), stagingDir, timeoutMs: 2000 }), (error) => error.code === "ANIMATION_RENDER_FAILED" && !error.message.includes(stagingDir));
  assert.equal(existsSync(jobOutputPath), false);
  assert.deepEqual(readdirSync(stagingDir), []);
});

test("provider classifies denied local renderer loopback without raw stderr", async () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "hf-loopback-denied-"));
  const provider = hyperframes.createHyperframesProvider({
    spawnImpl() {
      const child = fakeChild();
      process.nextTick(() => {
        child.stderr.write(
          "Error: listen EPERM: operation not permitted 127.0.0.1 /private/raw-path",
        );
        child.emit("close", 1);
      });
      return child;
    },
  });
  await assert.rejects(
    provider.render({
      animationIR: irFixture(),
      stagingDir,
      timeoutMs: 2000,
    }),
    (error) => (
      error.code === "ANIMATION_RENDER_FAILED"
      && error.details?.renderStage === "worker_loopback_denied"
      && !JSON.stringify(error).includes("raw-path")
    ),
  );
  assert.deepEqual(readdirSync(stagingDir), []);
});

test("provider waits for child close on cancellation and timeout", async () => {
  for (const mode of ["cancel", "timeout"]) {
    const stagingDir = mkdtempSync(join(tmpdir(), `hf-${mode}-`));
    let killed = false;
    const provider = hyperframes.createHyperframesProvider({ spawnImpl() { return fakeChild(() => { killed = true; }); } });
    const controller = new AbortController();
    const promise = provider.render({ animationIR: irFixture(), stagingDir, timeoutMs: mode === "timeout" ? 1000 : 5000 }, controller.signal);
    if (mode === "cancel") controller.abort();
    await assert.rejects(promise, (error) => error.code === (mode === "cancel" ? "ANIMATION_RENDER_CANCELLED" : "ANIMATION_RENDER_TIMEOUT"));
    assert.equal(killed, true);
  }
});

test("provider escalates and settles when a child ignores termination", async () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "hf-stubborn-child-"));
  const signals = [];
  const provider = hyperframes.createHyperframesProvider({
    spawnImpl() {
      const child = fakeChild();
      child.kill = (signalName) => {
        signals.push(signalName);
        return true;
      };
      return child;
    },
  });
  const started = Date.now();
  await assert.rejects(
    provider.render({
      animationIR: irFixture(),
      stagingDir,
      timeoutMs: 1000,
    }),
    { code: "ANIMATION_RENDER_TIMEOUT" },
  );
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.ok(Date.now() - started < 3000);
  assert.equal(existsSync(join(stagingDir, "animation-ir.json")), false);
  assert.equal(existsSync(join(stagingDir, "render-request.json")), false);
});

test("provider-owned manifest verification rejects fabrication and tampering", async () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "hf-verify-"));
  const ir = irFixture();
  const provider = hyperframes.createHyperframesProvider({
    spawnImpl(_command, args) {
      const requestIndex = args.indexOf("--request");
      const request = JSON.parse(
        readFileSync(args[requestIndex + 1], "utf8"),
      );
      const child = fakeChild();
      process.nextTick(() => {
        const output = "video-proof";
        writeFileSync(request.outputPath, output);
        child.stdout.write(`${JSON.stringify({
          type: "complete",
          outputFile: basename(request.outputPath),
          outputSha256: createHash("sha256").update(output).digest("hex"),
          animationIRHash: ir.contentHash,
          compositionHash: "f".repeat(64),
          provider: ir.renderer.provider,
          runtimeVersion: ir.renderer.runtimeVersion,
        })}\n`);
        child.emit("close", 0);
      });
      return child;
    },
  });
  const receipt = await provider.render({
    animationIR: ir,
    stagingDir,
    timeoutMs: 2000,
  });
  assert.equal(dirname(receipt.stagingDir), realpathSync(stagingDir));
  assert.equal(dirname(receipt.outputPath), receipt.stagingDir);
  assert.equal(provider.verify(receipt).valid, true);
  assert.throws(
    () => provider.verify({ ...receipt }),
    { code: "ANIMATION_MANIFEST_INVALID" },
  );
  assert.throws(
    () => hyperframes.verify(receipt),
    { code: "ANIMATION_MANIFEST_INVALID" },
  );
  writeFileSync(receipt.outputPath, "tampered");
  assert.throws(
    () => provider.verify(receipt),
    { code: "ANIMATION_OUTPUT_TAMPERED" },
  );
});
