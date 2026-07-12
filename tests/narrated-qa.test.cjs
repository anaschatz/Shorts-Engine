const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createQaReport, normalizeQaReport, gate, REQUIRED_CATEGORIES } = require("../server/pipelines/narrated-short/qa/contract.cjs");
const { DETECTOR_PROFILE, parseDetectorOutput, runRenderedVideoQa } = require("../server/pipelines/narrated-short/qa/rendered-video-qa.cjs");

function bindings() {
  const ids = ["draftArtifactId", "narrationManifestArtifactId", "audioArtifactId", "alignmentArtifactId", "captionManifestArtifactId", "captionAssArtifactId", "audioNormalizationReportArtifactId", "timelineArtifactId"];
  const hashes = ["draftHash", "scriptHash", "narrationManifestHash", "audioHash", "alignmentHash", "captionManifestHash", "captionAssHash", "audioNormalizationReportHash", "timelineHash", "outputHash"];
  return Object.fromEntries([...ids.map((key, index) => [key, `art_${String.fromCharCode(97 + index).repeat(40)}`]), ...hashes.map((key, index) => [key, (index % 10).toString(16).repeat(64)])]);
}
function passingGates() { return REQUIRED_CATEGORIES.map((category, index) => gate(["AUDIO_ALIGNMENT_EXACT", "CAPTION_ALIGNMENT_EXACT", "CONTENT_APPROVAL_EXACT", "VIDEO_FILE_READABLE", "RIGHTS_NARRATION_COMMERCIAL", "TIMELINE_HASH_VALID"][index], category, true)); }

test("QA report is strict, deterministic, canonical and category-complete", () => {
  const input = { projectId: `prj_${randomUUID()}`, projectRevision: 1, renderProfile: "preview", bindings: bindings(), gates: passingGates().reverse() };
  const first = createQaReport(input);
  const second = createQaReport({ ...input, gates: passingGates() });
  assert.equal(first.status, "passed");
  assert.equal(first.contentHash, second.contentHash);
  assert.deepEqual(first.gates.map((item) => item.category), [...REQUIRED_CATEGORIES].sort());
  assert.equal(normalizeQaReport(first).contentHash, first.contentHash);
  assert.throws(() => normalizeQaReport({ ...first, rawFfprobe: {} }), { code: "QA_REPORT_INVALID" });
  assert.throws(() => normalizeQaReport({ ...first, gates: [...first.gates, first.gates[0]] }), { code: "QA_REPORT_INVALID" });
  assert.throws(() => normalizeQaReport({ ...first, gates: first.gates.filter((item) => item.category !== "audio") }), { code: "QA_REPORT_INVALID" });
  assert.throws(() => normalizeQaReport({ ...first, summary: { ...first.summary, blockingPassedCount: 0 } }), { code: "QA_REPORT_INVALID" });
});

test("failed blocking gate produces a deterministic failed report and cannot claim pass", () => {
  const gates = passingGates();
  gates[0] = gate("AUDIO_ALIGNMENT_EXACT", "audio", false, { expected: 1, actual: 0 });
  const report = createQaReport({ projectId: `prj_${randomUUID()}`, projectRevision: 1, renderProfile: "final", bindings: bindings(), gates });
  assert.equal(report.status, "failed");
  assert.equal(report.summary.blockingFailedCount, 1);
  assert.throws(() => normalizeQaReport({ ...report, status: "passed", decision: "technical_qa_passed" }), { code: "QA_REPORT_INVALID" });
});

test("render detector parsing is bounded and distinguishes short fades from blockers", () => {
  const metrics = parseDetectorOutput("black_duration:0.4\nfreeze_duration:2.2\nsilence_duration:0.3", 30);
  assert.equal(metrics.black.longestSeconds, 0.4);
  const base = { size: 1024, durationSeconds: 30, videoCount: 1, audioCount: 1, width: 720, height: 1280, fps: 30, videoCodec: "h264", pixelFormat: "yuv420p", audioCodec: "aac", audioSampleRate: 48000, detector: metrics };
  const passed = runRenderedVideoQa({ analysis: base, timeline: { totalFrames: 900, fps: 30 }, renderProfile: "preview" });
  assert.ok(passed.every((item) => item.passed));
  const blocked = runRenderedVideoQa({ analysis: { ...base, detector: { ...metrics, black: { ratio: DETECTOR_PROFILE.blackRatioMax + 0.1, longestSeconds: 10 }, silence: { ratio: 1, longestSeconds: 30 } } }, timeline: { totalFrames: 900, fps: 30 }, renderProfile: "preview" });
  assert.equal(blocked.find((item) => item.code === "VIDEO_BLACK_OUTPUT_ABSENT").passed, false);
  assert.equal(blocked.find((item) => item.code === "VIDEO_AUDIO_NOT_SILENT").passed, false);
  assert.throws(() => parseDetectorOutput("", Number.NaN), { code: "RENDERED_VIDEO_QA_FAILED" });
});
