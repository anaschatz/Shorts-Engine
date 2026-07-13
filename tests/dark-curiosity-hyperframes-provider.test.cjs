const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { mkdtempSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");
const { compileAnimationIR } = require("../server/pipelines/narrated-short/animation/compiler.cjs");
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

test("provider maps child failures safely and cleans partial output", async () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "hf-failure-"));
  const provider = hyperframes.createHyperframesProvider({ spawnImpl() {
    const child = fakeChild();
    process.nextTick(() => { writeFileSync(join(stagingDir, "visual-master.mp4"), "partial"); child.stderr.write("private local path"); child.emit("close", 1); });
    return child;
  } });
  await assert.rejects(provider.render({ animationIR: irFixture(), stagingDir, timeoutMs: 2000 }), (error) => error.code === "ANIMATION_RENDER_FAILED" && !error.message.includes(stagingDir));
  assert.equal(existsSync(join(stagingDir, "visual-master.mp4")), false);
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

test("manifest verification detects output tampering", () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "hf-verify-"));
  const outputPath = join(stagingDir, "visual-master.mp4");
  writeFileSync(outputPath, "video-proof");
  const manifest = { outputPath, outputSha256: createHash("sha256").update("video-proof").digest("hex"), animationIRHash: irFixture().contentHash };
  assert.equal(hyperframes.verify(manifest).valid, true);
  writeFileSync(outputPath, "tampered");
  assert.throws(() => hyperframes.verify(manifest), { code: "ANIMATION_OUTPUT_TAMPERED" });
});
