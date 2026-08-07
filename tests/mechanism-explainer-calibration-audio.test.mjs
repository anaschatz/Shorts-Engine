import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  CALIBRATION_FINAL_HOLD_FRAMES,
  CALIBRATION_SAMPLE_RATE,
  CALIBRATION_SAMPLES_PER_FRAME,
  MECHANISM_EXPLAINER_CALIBRATION_AUDIO_PROFILE,
  allocateCalibrationWordTiming,
  buildMechanismExplainerCalibrationAudio,
  validateMechanismExplainerCalibrationInput,
} from "../tools/lib/mechanism-explainer-calibration-audio.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE_PATH = resolve(
  ROOT,
  "tools/lib/mechanism-explainer-calibration-audio.mjs",
);

function pcmWithSamples(sampleCount, value) {
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let offset = 0; offset < pcm.length; offset += 2) {
    pcm.writeInt16LE(value, offset);
  }
  return pcm;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function inputFixture() {
  return {
    id: "three_phrase_mechanism",
    phrases: [
      {
        id: "observe",
        text: "The scientist noticed one unusual pulse.",
        pauseAfterMs: 125,
        visual: {
          recipe: "human_observation",
          triggerToken: "unusual pulse",
        },
      },
      {
        id: "connect",
        text: "She connected the pulse to a repeating clock.",
        pauseAfterMs: 80,
        visual: {
          recipe: "human_connection",
          triggerToken: "connected",
        },
      },
      {
        id: "explain",
        text: "That pattern revealed the mechanism.",
        pauseAfterMs: 0,
        visual: {
          recipe: "human_payoff",
          triggerToken: "revealed",
        },
      },
    ],
  };
}

test("input validation is strict, generic, and preserves canonical visual intent", () => {
  const fixture = inputFixture();
  const validated = validateMechanismExplainerCalibrationInput(fixture);
  assert.deepEqual(validated, fixture);
  assert.notEqual(validated, fixture);
  assert.notEqual(validated.phrases[0].visual, fixture.phrases[0].visual);

  const duplicate = inputFixture();
  duplicate.phrases[1].id = "observe";
  assert.throws(
    () => validateMechanismExplainerCalibrationInput(duplicate),
    /id must be unique/,
  );

  const missingVisual = inputFixture();
  delete missingVisual.phrases[0].visual;
  assert.throws(
    () => validateMechanismExplainerCalibrationInput(missingVisual),
    /must contain exactly/,
  );

  const storySpecificField = inputFixture();
  storySpecificField.wowSignal = true;
  assert.throws(
    () => validateMechanismExplainerCalibrationInput(storySpecificField),
    /must contain exactly/,
  );
});

test("word allocation is deterministic, contiguous, and bounded by exact speech", () => {
  const request = {
    phraseId: "mechanism",
    text: "A human connects the evidence.",
    startSample: 3200,
    sampleCount: 6400,
    startFrame: 2,
    endFrame: 6,
    globalIndexStart: 7,
  };
  const first = allocateCalibrationWordTiming(request);
  const second = allocateCalibrationWordTiming(request);
  assert.deepEqual(first, second);
  assert.equal(first[0].startSample, 3200);
  assert.equal(first.at(-1).endSample, 9600);
  assert.equal(first[0].startFrame, 2);
  assert.equal(first.at(-1).endFrame, 6);
  assert.deepEqual(
    first.map((word) => word.globalIndex),
    [7, 8, 9, 10, 11],
  );
  first.slice(1).forEach((word, index) => {
    assert.equal(word.startSample, first[index].endSample);
    assert.equal(word.startFrame, first[index].endFrame);
  });
});

test("injected phrase PCM produces exact sample ranges and a contiguous 30fps clock", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "calibration-audio-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "calibration.wav");
  const phraseSamples = [3000, 4100, 2500];
  const calls = [];
  const result = await buildMechanismExplainerCalibrationAudio(
    inputFixture(),
    { outputPath },
    {
      renderPhrasePcm: async ({ phrase, phraseIndex, ...contract }) => {
        calls.push({ phrase, phraseIndex, contract });
        return pcmWithSamples(
          phraseSamples[phraseIndex],
          1000 + phraseIndex,
        );
      },
    },
  );

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.phrase.id), [
    "observe",
    "connect",
    "explain",
  ]);
  assert.ok(calls.every((call) => call.contract.sampleRate === 48_000));
  assert.ok(calls.every((call) => call.contract.format === "pcm_s16le"));

  assert.deepEqual(
    result.phrases.map((phrase) => ({
      id: phrase.id,
      startSample: phrase.startSample,
      audioEndSample: phrase.audio.endSample,
      pauseEndSample: phrase.pause.endSample,
      alignmentPaddingSamples: phrase.alignmentPaddingSamples,
      endSample: phrase.endSample,
      startFrame: phrase.startFrame,
      endFrame: phrase.endFrame,
    })),
    [
      {
        id: "observe",
        startSample: 0,
        audioEndSample: 3000,
        pauseEndSample: 9000,
        alignmentPaddingSamples: 600,
        endSample: 9600,
        startFrame: 0,
        endFrame: 6,
      },
      {
        id: "connect",
        startSample: 9600,
        audioEndSample: 13700,
        pauseEndSample: 17540,
        alignmentPaddingSamples: 60,
        endSample: 17600,
        startFrame: 6,
        endFrame: 11,
      },
      {
        id: "explain",
        startSample: 17600,
        audioEndSample: 20100,
        pauseEndSample: 20100,
        alignmentPaddingSamples: 700,
        endSample: 68800,
        startFrame: 11,
        endFrame: 43,
      },
    ],
  );
  assert.equal(result.durationSamples, 68_800);
  assert.equal(result.durationFrames, 43);
  assert.equal(
    result.durationSamples,
    result.durationFrames * CALIBRATION_SAMPLES_PER_FRAME,
  );
  assert.equal(result.frameClock.finalHold.startFrame, 13);
  assert.equal(result.frameClock.finalHold.endFrame, 43);
  assert.equal(
    result.frameClock.finalHold.frameCount,
    CALIBRATION_FINAL_HOLD_FRAMES,
  );
  assert.deepEqual(
    result.phrases.map((phrase) => [phrase.startFrame, phrase.endFrame]),
    [[0, 6], [6, 11], [11, 43]],
  );
  assert.equal(result.phrases[0].triggerFrame, 1);
  assert.equal(result.phrases[1].triggerFrame, 6);
  assert.equal(result.phrases[2].triggerFrame, 11);
  result.phrases.forEach((phrase) => {
    assert.ok(phrase.triggerFrame >= phrase.startFrame);
    assert.ok(phrase.triggerFrame < phrase.audio.endFrame);
    assert.equal(phrase.words[0].startSample, phrase.audio.startSample);
    assert.equal(phrase.words.at(-1).endSample, phrase.audio.endSample);
    assert.equal(phrase.words.at(-1).endFrame, phrase.pause.startFrame);
  });
});

test("output WAV, SHA, and calibration-only provenance are internally bound", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "calibration-audio-proof-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "proof.wav");
  const result = await buildMechanismExplainerCalibrationAudio(
    {
      id: "single_phrase",
      phrases: [{
        id: "observe",
        text: "A scientist sees the result.",
        pauseAfterMs: 0,
        visual: { recipe: "human_observation", triggerToken: null },
      }],
    },
    { outputPath },
    {
      renderPhrasePcm: async () => pcmWithSamples(8000, 1200),
    },
  );
  const wav = readFileSync(outputPath);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), CALIBRATION_SAMPLE_RATE);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(result.audioSha256, sha256(wav));
  assert.equal(
    result.profile,
    MECHANISM_EXPLAINER_CALIBRATION_AUDIO_PROFILE,
  );
  assert.equal(result.publishable, false);
  assert.equal(result.provenance.calibration, true);
  assert.equal(result.provenance.publishable, false);
  assert.equal(result.provenance.commercialUseAttested, false);
  assert.equal(result.provenance.commercialUseAttestation, null);
  assert.equal(
    result.provenance.rightsStatus,
    "commercial_use_not_attested",
  );
  assert.equal(result.provenance.audioSha256, result.audioSha256);
  assert.deepEqual(result.releaseBlockers, [
    "CALIBRATION_ONLY",
    "COMMERCIAL_USE_ATTESTATION_REQUIRED",
  ]);
  assert.equal(result.phrases[0].triggerFrame, 0);
  assert.equal(result.phrases[0].endFrame, result.durationFrames);
});

test("an unresolved semantic trigger fails instead of silently mistiming visuals", async () => {
  const fixture = inputFixture();
  fixture.phrases[0].visual.triggerToken = "missing concept";
  await assert.rejects(
    buildMechanismExplainerCalibrationAudio(
      fixture,
      {},
      { renderPhrasePcm: async () => pcmWithSamples(8000, 1000) },
    ),
    /triggerToken .* does not occur/,
  );
});

test("production execution is explicitly spawn-only with no shell path", () => {
  const source = readFileSync(SOURCE_PATH, "utf8");
  assert.match(source, /spawn as nodeSpawn/);
  assert.match(source, /shell: false/);
  assert.doesNotMatch(source, /\bexec(?:File|Sync)?\s*\(/);
  assert.match(source, /one_helper_spawn_per_phrase/);
  assert.match(source, /"-c:a",\s+"pcm_s16le"/);
});
