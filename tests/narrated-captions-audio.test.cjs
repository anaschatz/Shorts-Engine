const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { randomUUID, createHash } = require("node:crypto");

const { normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const { createAlignment, scriptWords } = require("../server/pipelines/narrated-short/narration/alignment.cjs");
const { createCaptionManifest, normalizeCaptionManifest } = require("../server/pipelines/narrated-short/captions/contract.cjs");
const { assTime, escapeAssText, generateAss } = require("../server/pipelines/narrated-short/captions/ass-generator.cjs");
const { AUDIO_TARGET, createAudioNormalizationReport, normalizeAudioNormalizationReport, parseLoudnormMeasurement } = require("../server/pipelines/narrated-short/audio-normalization.cjs");

function fixture() {
  const draft = normalizeDraftBundle(JSON.parse(readFileSync(resolve(__dirname, "..", "eval", "narrated", "dark-curiosity", "fixtures", "001_wow_signal_mystery.json"), "utf8")));
  const projectId = `prj_${randomUUID()}`;
  const art = (letter) => `art_${letter.repeat(40)}`;
  const hash = (letter) => letter.repeat(64);
  const narration = { media: { durationSeconds: 32 }, language: "en", voiceProfileId: "voice", rights: { commercialUseAllowed: true, consentReference: "consent" }, draftArtifactId: art("a"), draftHash: hash("a"), scriptHash: draft.script.contentHash, audioArtifactId: art("d"), audioHash: hash("d") };
  const summary = { draftArtifactId: art("a"), draftHash: hash("a"), scriptHash: draft.script.contentHash, manifestArtifactId: art("c"), manifestHash: hash("c"), audioArtifactId: narration.audioArtifactId, audioHash: narration.audioHash };
  const words = scriptWords(draft.script).map((word, index) => ({ word: word.text, start: 0.2 + index * 0.32, end: 0.45 + index * 0.32, probability: 0.98 }));
  const alignment = createAlignment({ project: { id: projectId, input: { revision: 1 } }, draft, narration, narrationSummary: summary, providerResult: { segments: [{ words }] }, provider: { model: "fixture", device: "cpu", computeType: "int8" } });
  const alignmentArtifactId = art("e");
  const alignmentHash = createHash("sha256").update(JSON.stringify(alignment)).digest("hex");
  return { alignment, alignmentArtifactId, alignmentHash, manifest: createCaptionManifest({ alignment, alignmentArtifactId, alignmentHash }) };
}

test("caption manifest deterministically covers exact aligned words and beats", () => {
  const value = fixture();
  const again = createCaptionManifest(value);
  assert.equal(again.contentHash, value.manifest.contentHash);
  assert.deepEqual(again.cues, value.manifest.cues);
  assert.equal(again.cues.flatMap((cue) => cue.words).length, value.alignment.words.length);
  assert.ok(again.cues.every((cue) => cue.lines.length <= 2));
  assert.deepEqual([...new Set(again.cues.map((cue) => cue.beatId))], value.alignment.beats.map((beat) => beat.beatId));
});

test("caption contract rejects unknown fields, missing/reordered/orphan words and invalid cue timings", () => {
  const { alignment, manifest } = fixture();
  const rejects = [
    { ...manifest, rawTranscript: "unsafe" },
    { ...manifest, cues: [{ ...manifest.cues[0], words: manifest.cues[0].words.slice(1) }, ...manifest.cues.slice(1)] },
    { ...manifest, cues: [{ ...manifest.cues[0], words: [manifest.cues[0].words[1], manifest.cues[0].words[0], ...manifest.cues[0].words.slice(2)] }, ...manifest.cues.slice(1)] },
    { ...manifest, cues: [...manifest.cues, { ...manifest.cues.at(-1), id: `cue_${String(manifest.cues.length + 1).padStart(4, "0")}` }] },
    { ...manifest, cues: [{ ...manifest.cues[0], endFrame: manifest.durationFrames + 1 }, ...manifest.cues.slice(1)] },
    { ...manifest, cues: [manifest.cues[0], { ...manifest.cues[1], startFrame: manifest.cues[0].endFrame - 1 }, ...manifest.cues.slice(2)] },
  ];
  rejects.forEach((value) => assert.throws(() => normalizeCaptionManifest(value, { alignment }), (error) => ["CAPTION_CONTRACT_INVALID", "CAPTION_ALIGNMENT_REQUIRED"].includes(error.code)));
});

test("ASS generation is deterministic, Unicode-safe and blocks override injection", () => {
  const { manifest } = fixture();
  const font = { available: true, name: "Arial", filePath: "/managed/Arial.ttf", fontsDir: "/managed" };
  const first = generateAss(manifest, { font });
  const second = generateAss(manifest, { font });
  assert.deepEqual(first.buffer, second.buffer);
  assert.match(first.buffer.toString("utf8"), /\\kf\d+/);
  assert.equal(assTime(30), "0:00:01.00");
  assert.equal(escapeAssText("{\\b1} Δοκιμή"), "（／b1） Δοκιμή");
  assert.throws(() => generateAss(manifest, { font: { available: false } }), { code: "CAPTION_FONT_UNAVAILABLE" });
});

test("loudnorm parsing and report contract reject non-finite or unbound measurements", () => {
  const raw = `noise\n${JSON.stringify({ input_i: "-22.10", input_tp: "-4.20", input_lra: "3.10", input_thresh: "-32.20", output_i: "-16.02", output_tp: "-1.60", output_lra: "3.00", target_offset: "0.02" })}`;
  const loudness = parseLoudnormMeasurement(raw);
  assert.equal(loudness.input.integratedLoudness, -22.1);
  const report = createAudioNormalizationReport({ projectId: `prj_${randomUUID()}`, projectRevision: 1, audioArtifactId: `art_${"a".repeat(40)}`, audioHash: "a".repeat(64), alignmentArtifactId: `art_${"b".repeat(40)}`, alignmentHash: "b".repeat(64), loudness });
  assert.deepEqual(report.target, AUDIO_TARGET);
  assert.equal(normalizeAudioNormalizationReport(report).contentHash, report.contentHash);
  assert.throws(() => parseLoudnormMeasurement('{"input_i":"-inf"}'), { code: "AUDIO_NORMALIZATION_FAILED" });
  assert.throws(() => normalizeAudioNormalizationReport({ ...report, target: { ...report.target, integratedLoudness: -14 } }), { code: "AUDIO_NORMALIZATION_FAILED" });
});
