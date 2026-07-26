const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { randomUUID, createHash } = require("node:crypto");

const { contentHash, normalizeDraftBundle } = require("../server/pipelines/narrated-short/contracts.cjs");
const { createAlignment, scriptWords } = require("../server/pipelines/narrated-short/narration/alignment.cjs");
const { TTS_PROVENANCE_SCHEMA_V3 } = require("../server/pipelines/narrated-short/narration/tts/contract.cjs");
const { buildPacingPlan, pacingSummary } = require("../server/pipelines/narrated-short/narration/tts/pacing-plan.cjs");
const { ACOUSTIC_GAP_FRAMES, CAPTION_PROFILE_VERSION, LEGACY_CAPTION_PROFILE_VERSION, TARGET_MAX_WORDS_PER_CUE, TARGET_MIN_WORDS_PER_CUE, createCaptionManifest, groupAlignmentWords, normalizeCaptionManifest, normalizeCaptionManifestForRead, splitLines } = require("../server/pipelines/narrated-short/captions/contract.cjs");
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
  return { draft, narration, alignment, alignmentArtifactId, alignmentHash, manifest: createCaptionManifest({ alignment, alignmentArtifactId, alignmentHash }) };
}

function syntheticPacingAlignment(baseAlignment) {
  const beatSpecs = [
    {
      beatId: "beat_evidence",
      words: [
        { text: "Its" }, { text: "strength" }, { text: "rose" }, { text: "and" }, { text: "fell" },
        { text: "as", gapBefore: ACOUSTIC_GAP_FRAMES }, { text: "the" }, { text: "telescope" }, { text: "beam" }, { text: "crossed" }, { text: "the" }, { text: "source," },
        { text: "making", gapBefore: ACOUSTIC_GAP_FRAMES }, { text: "ordinary" }, { text: "local" }, { text: "interference" }, { text: "less" }, { text: "convincing." },
      ],
    },
    {
      beatId: "beat_turn",
      words: [
        { text: "But" }, { text: "later" }, { text: "searches" }, { text: "never" }, { text: "verified" }, { text: "the" }, { text: "same" }, { text: "signal" }, { text: "again," },
        { text: "and" }, { text: "no" }, { text: "confirmed" }, { text: "transmission" }, { text: "has" }, { text: "explained" }, { text: "it." },
        { text: "The" }, { text: "result" }, { text: "stayed" }, { text: "unresolved." },
      ],
    },
  ];
  const words = [];
  const beats = [];
  let frame = 0;
  for (const beatSpec of beatSpecs) {
    const wordStartIndex = words.length;
    for (const spec of beatSpec.words) {
      frame += spec.gapBefore || 0;
      words.push({ index: words.length, text: spec.text, startFrame: frame, endFrame: frame + 3, confidence: 0.99 });
      frame += 3;
    }
    beats.push({ beatId: beatSpec.beatId, wordStartIndex, wordEndIndex: words.length, startFrame: words[wordStartIndex].startFrame, endFrame: words.at(-1).endFrame });
  }
  const { contentHash: _contentHash, ...base } = baseAlignment;
  return {
    ...base,
    durationFrames: frame + 30,
    words,
    beats,
    coverage: { expectedWords: words.length, alignedWords: words.length, exactSequenceMatch: true, coverageRatio: 1 },
  };
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

test("historical caption manifests remain readable without becoming valid current render inputs", () => {
  const base = fixture();
  const alignment = syntheticPacingAlignment(base.alignment);
  const current = createCaptionManifest({ alignment, alignmentArtifactId: base.alignmentArtifactId, alignmentHash: createHash("sha256").update(JSON.stringify(alignment)).digest("hex") });
  const crossedBoundaryWords = [...current.cues[0].words, current.cues[1].words[0]];
  const remainingWords = current.cues[1].words.slice(1);
  const legacyCues = current.cues.map((cue, index) => index === 0
    ? { ...cue, endFrame: crossedBoundaryWords.at(-1).endFrame, lines: splitLines(crossedBoundaryWords), words: crossedBoundaryWords }
    : index === 1
      ? { ...cue, startFrame: remainingWords[0].startFrame, lines: splitLines(remainingWords), words: remainingWords }
      : cue);
  const {
    pacingProfile: _pacingProfile,
    pacingPlanHash: _pacingPlanHash,
    semanticBoundaryWordIndices: _semanticBoundaryWordIndices,
    contentHash: _currentContentHash,
    ...legacyBody
  } = current;
  legacyBody.profileVersion = LEGACY_CAPTION_PROFILE_VERSION;
  legacyBody.cues = legacyCues;
  const legacy = { ...legacyBody, contentHash: contentHash(legacyBody) };

  assert.equal(current.profileVersion, CAPTION_PROFILE_VERSION);
  assert.equal(legacy.cues[0].words.at(-1).text, "as");
  assert.deepEqual(normalizeCaptionManifestForRead(legacy, { alignment }), legacy);
  assert.throws(() => normalizeCaptionManifest(legacy, { alignment }), (error) => error.code === "CAPTION_CONTRACT_INVALID");
  assert.throws(() => generateAss(legacy, { font: { available: true, name: "Arial", filePath: "/managed/Arial.ttf", fontsDir: "/managed" } }), (error) => error.code === "CAPTION_CONTRACT_INVALID");
  assert.throws(() => normalizeCaptionManifestForRead({ ...legacy, contentHash: "f".repeat(64) }, { alignment }), (error) => error.code === "CAPTION_CONTRACT_INVALID" && error.details.field === "contentHash");
  assert.throws(() => normalizeCaptionManifestForRead(legacy, { alignment, narration: {} }), (error) => error.code === "CAPTION_CONTRACT_INVALID" && error.details.field === "semanticPacing");
});

test("caption grouping follows clauses and acoustic gaps without orphaning aligned words", () => {
  const base = fixture();
  const alignment = syntheticPacingAlignment(base.alignment);
  const cues = groupAlignmentWords(alignment);
  const cueText = cues.map((cue) => cue.words.map((word) => word.text).join(" "));
  assert.deepEqual(cueText, [
    "Its strength rose and fell",
    "as the telescope beam",
    "crossed the source,",
    "making ordinary local",
    "interference less convincing.",
    "But later searches never",
    "verified the same signal again,",
    "and no confirmed transmission",
    "has explained it.",
    "The result stayed unresolved.",
  ]);
  assert.ok(cues.every((cue) => cue.words.length >= TARGET_MIN_WORDS_PER_CUE && cue.words.length <= TARGET_MAX_WORDS_PER_CUE));
  assert.ok(cues.every((cue) => !/^(?:a|an|the|and|as|but|for|nor|or|so|that|yet)$/i.test(cue.words.at(-1).text.replace(/[^A-Za-z]/g, ""))));
  cues.forEach((cue) => {
    assert.equal(cue.startFrame, cue.words[0].startFrame);
    assert.equal(cue.endFrame, cue.words.at(-1).endFrame);
    for (let index = 1; index < cue.words.length; index += 1) assert.ok(cue.words[index].startFrame - cue.words[index - 1].endFrame < ACOUSTIC_GAP_FRAMES);
  });
  const fellCue = cues.find((cue) => cue.words.some((word) => word.text === "fell"));
  const asCue = cues.find((cue) => cue.words[0].text === "as");
  assert.equal(asCue.startFrame - fellCue.endFrame, ACOUSTIC_GAP_FRAMES);
  const againCue = cues.find((cue) => cue.words.at(-1).text === "again,");
  const andCue = cues.find((cue) => cue.words[0].text === "and");
  assert.equal(andCue.startFrame, againCue.endFrame);
  const explainedCue = cues.find((cue) => cue.words.at(-1).text === "it.");
  const resultCue = cues.find((cue) => cue.words[0].text === "The");
  assert.equal(resultCue.startFrame, explainedCue.endFrame);
  const manifest = createCaptionManifest({ alignment, alignmentArtifactId: base.alignmentArtifactId, alignmentHash: createHash("sha256").update(JSON.stringify(alignment)).digest("hex") });
  assert.deepEqual(manifest.cues, cues);
  assert.equal(normalizeCaptionManifest(manifest, { alignment }).contentHash, manifest.contentHash);
});

test("semantic pacing boundaries keep each narrated idea in its own caption cue", () => {
  const value = fixture();
  const plan = buildPacingPlan(value.draft.script);
  const narration = { ...value.narration, ttsProvenance: { schemaVersion: TTS_PROVENANCE_SCHEMA_V3, pacing: pacingSummary(plan) } };
  const manifest = createCaptionManifest({ alignment: value.alignment, alignmentArtifactId: value.alignmentArtifactId, alignmentHash: value.alignmentHash, narration });
  const cueText = manifest.cues.map((cue) => cue.words.map((word) => word.text).join(" "));
  const turnSetupCueIndex = cueText.indexOf("But later searches");
  assert.notEqual(turnSetupCueIndex, -1);
  assert.match(cueText[turnSetupCueIndex + 1], /^never\b/);
  assert.equal(manifest.pacingProfile, plan.profile);
  assert.equal(manifest.pacingPlanHash, plan.contentHash);
  assert.deepEqual(manifest.semanticBoundaryWordIndices, pacingSummary(plan).semanticBoundaryWordIndices);
  for (const boundary of manifest.semanticBoundaryWordIndices) {
    assert.ok(manifest.cues.every((cue) => !(cue.words[0].wordIndex < boundary && cue.words.at(-1).wordIndex >= boundary)));
  }
  assert.equal(normalizeCaptionManifest(manifest, { alignment: value.alignment, narration }).contentHash, manifest.contentHash);

  const leftIndex = manifest.cues.findIndex((cue) => cue.words.at(-1).wordIndex === plan.segments.find((segment) => segment.id === "turn_search_setup").wordEndIndex - 1);
  const left = manifest.cues[leftIndex];
  const right = manifest.cues[leftIndex + 1];
  const crossedLeftWords = [...left.words, right.words[0]];
  const crossedRightWords = right.words.slice(1);
  const crossed = manifest.cues.map((cue, index) => index === leftIndex
    ? { ...cue, endFrame: crossedLeftWords.at(-1).endFrame, lines: splitLines(crossedLeftWords), words: crossedLeftWords }
    : index === leftIndex + 1
      ? { ...cue, startFrame: crossedRightWords[0].startFrame, lines: splitLines(crossedRightWords), words: crossedRightWords }
      : cue);
  assert.throws(() => normalizeCaptionManifest({ ...manifest, cues: crossed, contentHash: undefined }), (error) => error.code === "CAPTION_CONTRACT_INVALID" && /words/.test(error.details.field));
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
