const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const DATA_DIR = mkdtempSync(join(tmpdir(), "narrated-audio-integration-"));
process.env.MATCHCUTS_DATA_DIR = DATA_DIR;
const { CONFIG, ensureDataDirs } = require("../server/config.cjs");
ensureDataDirs();
const { sha256 } = require("../server/media.cjs");
const { LocalArtifactAdapter } = require("../server/adapters/local-artifact-adapter.cjs");
const { InMemoryArtifactRepository } = require("../server/repositories/artifact-repository.cjs");
const { ContentArtifactRepository } = require("../server/repositories/content-artifact-repository.cjs");
const { normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const { createAlignment, scriptWords } = require("../server/pipelines/narrated-short/narration/alignment.cjs");
const { createCaptionManifest } = require("../server/pipelines/narrated-short/captions/contract.cjs");
const { captionFontConfig, generateAss } = require("../server/pipelines/narrated-short/captions/ass-generator.cjs");
const { persistAssArtifact } = require("../server/pipelines/narrated-short/captions/artifact.cjs");
const { composeNarratedPreview } = require("../server/pipelines/narrated-short/video-compositor.cjs");
const { analyzeRenderedVideo, runRenderedVideoQa } = require("../server/pipelines/narrated-short/qa/rendered-video-qa.cjs");
const { createQaReport, gate } = require("../server/pipelines/narrated-short/qa/contract.cjs");
const { generateContactSheet } = require("../server/pipelines/narrated-short/evidence/contact-sheet.cjs");
const { normalizeContactSheet } = require("../server/pipelines/narrated-short/evidence/contract.cjs");

test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

test("real FFmpeg burns managed ASS and muxes normalized managed PCM narration", async (t) => {
  const filters = spawnSync(CONFIG.ffmpegBin, ["-hide_banner", "-filters"], { encoding: "utf8" });
  const filterText = `${filters.stdout || ""}\n${filters.stderr || ""}`;
  const font = captionFontConfig();
  if (filters.status !== 0 || !/\b(?:ass|subtitles)\b/.test(filterText) || !font.available) {
    t.skip("FFmpeg libass filter or approved local font is unavailable");
    return;
  }
  const root = mkdtempSync(join(CONFIG.tmpDir, "real-narrated-audio-"));
  try {
    const wavPath = join(root, "voice.wav");
    const framePath = join(root, "frame.png");
    assert.equal(spawnSync(CONFIG.ffmpegBin, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3", "-ac", "1", "-c:a", "pcm_s16le", wavPath], { stdio: "ignore" }).status, 0);
    assert.equal(spawnSync(CONFIG.ffmpegBin, ["-y", "-f", "lavfi", "-i", "color=c=0x111827:s=720x1280", "-frames:v", "1", framePath], { stdio: "ignore" }).status, 0);
    const artifactStore = new LocalArtifactAdapter();
    const artifactRepository = new InMemoryArtifactRepository({ persist: false });
    const contentArtifactRepository = new ContentArtifactRepository({ artifactStore, artifactRepository });
    const projectId = `prj_${randomUUID()}`;
    const jobId = `job_${randomUUID()}`;
    const audioBuffer = readFileSync(wavPath);
    const audioHash = sha256(audioBuffer);
    const audioArtifact = artifactStore.writeBuffer({ id: `art_${"d".repeat(40)}`, type: "narration_audio", ownerProjectId: projectId, storageKey: `narration/${projectId}/voice.wav`, checksumSha256: audioHash, contentType: "audio/wav", buffer: audioBuffer, status: "available" });
    artifactRepository.create(audioArtifact);
    const draft = normalizeDraftBundle(JSON.parse(readFileSync(resolve(__dirname, "..", "eval", "narrated", "dark-curiosity", "fixtures", "001_wow_signal_mystery.json"), "utf8")));
    const draftArtifactId = `art_${"a".repeat(40)}`;
    const manifestArtifactId = `art_${"c".repeat(40)}`;
    const words = scriptWords(draft.script).map((word, index) => ({ word: word.text, start: 0.08 + index * 0.035, end: 0.105 + index * 0.035, probability: 0.99 }));
    const narration = { draftArtifactId, draftHash: "a".repeat(64), scriptHash: draft.script.contentHash, audioArtifactId: audioArtifact.id, audioHash, language: "en", media: { durationSeconds: 3 } };
    const alignment = createAlignment({ project: { id: projectId, input: { revision: 1 } }, draft, narration, narrationSummary: { manifestArtifactId, manifestHash: "c".repeat(64) }, providerResult: { segments: [{ words }] }, provider: { model: "fixture", device: "cpu", computeType: "int8" } });
    const alignmentArtifact = contentArtifactRepository.createJson({ type: "narration_alignment", projectId, jobId, revision: 1, dependencyHashes: [audioHash, draft.script.contentHash], body: alignment });
    const captionManifest = createCaptionManifest({ alignment, alignmentArtifactId: alignmentArtifact.artifact.id, alignmentHash: alignmentArtifact.envelope.contentHash });
    const captionArtifact = contentArtifactRepository.createJson({ type: "caption_manifest", projectId, jobId, revision: 1, dependencyHashes: [alignmentArtifact.envelope.contentHash], body: captionManifest });
    const ass = generateAss(captionManifest, { font });
    const assArtifact = persistAssArtifact({ artifactStore, artifactRepository, projectId, projectRevision: 1, jobId, captionManifestHash: captionArtifact.envelope.contentHash, alignmentHash: alignmentArtifact.envelope.contentHash, rendererVersion: captionManifest.rendererVersion, buffer: ass.buffer });
    const audioStage = artifactStore.stageInputForProcessing(audioArtifact);
    const assStage = artifactStore.stageInputForProcessing(assArtifact);
    const output = artifactStore.createOutputStage("export", { id: `exp_${randomUUID()}`, ownerProjectId: projectId, ownerJobId: jobId, storageKey: `narrated/${jobId}.mp4`, contentType: "video/mp4" });
    const timeline = { contentHash: "f".repeat(64), fps: 30, width: 720, height: 1280, totalFrames: 90 };
    const result = await composeNarratedPreview({ timeline, keyframeManifest: { timelineHash: timeline.contentHash, frames: [{ globalFrame: 0, outputPath: framePath, fileName: "frame.png" }] }, outputPath: output.localPath, audioPath: audioStage.localPath, assPath: assStage.localPath, font: ass.font, renderProfile: "preview" });
    assert.equal(result.audioIncluded, true);
    assert.equal(result.captionsBurned, true);
    assert.equal(result.audioNormalized, true);
    assert.equal(result.audioCodec, "aac");
    assert.equal(result.audioSampleRate, 48000);
    assert.equal(result.width, 720);
    assert.equal(result.height, 1280);
    const analysis = await analyzeRenderedVideo({ outputPath: output.localPath, timeline, renderProfile: "preview" });
    const videoGates = runRenderedVideoQa({ analysis, timeline, renderProfile: "preview" });
    assert.ok(videoGates.every((item) => item.passed));
    const qaBindings = { draftArtifactId, draftHash: narration.draftHash, scriptHash: draft.script.contentHash, narrationManifestArtifactId: manifestArtifactId, narrationManifestHash: "c".repeat(64), audioArtifactId: audioArtifact.id, audioHash, alignmentArtifactId: alignmentArtifact.artifact.id, alignmentHash: alignmentArtifact.envelope.contentHash, captionManifestArtifactId: captionArtifact.artifact.id, captionManifestHash: captionArtifact.envelope.contentHash, captionAssArtifactId: assArtifact.id, captionAssHash: assArtifact.checksumSha256, audioNormalizationReportArtifactId: `art_${"b".repeat(40)}`, audioNormalizationReportHash: "b".repeat(64), timelineArtifactId: `art_${"f".repeat(40)}`, timelineHash: timeline.contentHash, outputHash: sha256(output.localPath) };
    const report = createQaReport({ projectId, projectRevision: 1, renderProfile: "preview", bindings: qaBindings, gates: [gate("AUDIO_ALIGNMENT_EXACT", "audio", true), gate("CAPTION_ALIGNMENT_EXACT", "caption", true), gate("CONTENT_APPROVAL_EXACT", "content", true), ...videoGates, gate("RIGHTS_NARRATION_COMMERCIAL", "rights", true), gate("TIMELINE_HASH_VALID", "timeline", true)] });
    const qaArtifact = contentArtifactRepository.createJson({ type: "qa_report", projectId, jobId, revision: 1, dependencyHashes: [qaBindings.outputHash, alignmentArtifact.envelope.contentHash], body: report });
    assert.equal(qaArtifact.envelope.body.status, "passed");
    assert.equal(qaArtifact.envelope.body.bindings.outputHash, sha256(output.localPath));
    const contact = await generateContactSheet({ outputPath: output.localPath, timeline, bindings: { projectId, projectRevision: 1, approvalId: `capr_${"a".repeat(40)}`, draftArtifactId, draftHash: narration.draftHash, outputHash: qaBindings.outputHash, qaReportArtifactId: qaArtifact.artifact.id, qaReportHash: qaArtifact.envelope.contentHash }, artifactStore, artifactRepository, projectId, jobId });
    const normalizedContact = normalizeContactSheet(contact.descriptor);
    assert.equal(normalizedContact.width, 1080);
    assert.equal(normalizedContact.height, 1280);
    assert.equal(normalizedContact.frameCount, 6);
    assert.equal(normalizedContact.bindings.outputHash, sha256(output.localPath));
    assert.equal(contact.artifact.checksumSha256, normalizedContact.checksumSha256);
    assert.deepEqual(readFileSync(contact.artifact.path).subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const invalidPath = join(root, "black-silent.mp4");
    assert.equal(spawnSync(CONFIG.ffmpegBin, ["-y", "-f", "lavfi", "-i", "color=c=black:s=720x1280:r=30:d=3", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", invalidPath], { stdio: "ignore" }).status, 0);
    const invalidAnalysis = await analyzeRenderedVideo({ outputPath: invalidPath, timeline, renderProfile: "preview" });
    const invalidGates = runRenderedVideoQa({ analysis: invalidAnalysis, timeline, renderProfile: "preview" });
    assert.equal(invalidGates.find((item) => item.code === "VIDEO_BLACK_OUTPUT_ABSENT").passed, false);
    assert.equal(invalidGates.find((item) => item.code === "VIDEO_AUDIO_NOT_SILENT").passed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
