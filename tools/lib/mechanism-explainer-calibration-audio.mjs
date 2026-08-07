import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const {
  KOKORO_LICENSE_REFERENCE,
  KOKORO_MODEL_ID,
  KOKORO_RUNTIME_VERSION,
  KOKORO_VOICES,
  config: kokoroConfig,
} = require(
  "../../server/pipelines/narrated-short/narration/tts/kokoro-runtime.cjs",
);

export const MECHANISM_EXPLAINER_CALIBRATION_AUDIO_PROFILE =
  "mechanism_explainer_calibration_audio_v1";
export const CALIBRATION_SAMPLE_RATE = 48_000;
export const CALIBRATION_CHANNELS = 1;
export const CALIBRATION_FPS = 30;
export const CALIBRATION_SAMPLES_PER_FRAME =
  CALIBRATION_SAMPLE_RATE / CALIBRATION_FPS;
export const CALIBRATION_FINAL_HOLD_FRAMES = 30;

const PCM_BYTES_PER_SAMPLE = 2;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_VOICE_ID = "af_heart";
const DEFAULT_LANGUAGE = "en";
const DEFAULT_SPEAKING_RATE = 1;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,95}$/;

function fail(message) {
  throw new TypeError(`Mechanism explainer calibration audio invalid: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value, path = "value") {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${path} must contain only finite numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  }
  if (!isPlainObject(value)) {
    fail(`${path} must contain only JSON-compatible values`);
  }
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) {
      fail(`${path}.${key} must not be undefined`);
    }
    output[key] = canonicalize(value[key], `${path}.${key}`);
  }
  return output;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function assertExactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${path} must contain exactly ${wanted.join(", ")}`);
  }
}

function normalizeComparableToken(value) {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function tokenizeCalibrationPhrase(text) {
  return String(text).trim().split(/\s+/u).filter(Boolean);
}

export function validateMechanismExplainerCalibrationInput(input) {
  if (!isPlainObject(input)) fail("input must be an object");
  assertExactKeys(input, ["id", "phrases"], "input");
  if (!ID_PATTERN.test(input.id)) {
    fail("input.id must be a lowercase stable identifier");
  }
  if (
    !Array.isArray(input.phrases)
    || input.phrases.length < 1
    || input.phrases.length > 16
  ) {
    fail("input.phrases must contain between 1 and 16 phrases");
  }

  const ids = new Set();
  const phrases = input.phrases.map((phrase, index) => {
    const path = `input.phrases[${index}]`;
    if (!isPlainObject(phrase)) fail(`${path} must be an object`);
    assertExactKeys(phrase, ["id", "pauseAfterMs", "text", "visual"], path);
    if (!ID_PATTERN.test(phrase.id)) {
      fail(`${path}.id must be a lowercase stable identifier`);
    }
    if (ids.has(phrase.id)) fail(`${path}.id must be unique`);
    ids.add(phrase.id);
    if (
      typeof phrase.text !== "string"
      || phrase.text.trim().length < 1
      || phrase.text.trim().length > 1000
    ) {
      fail(`${path}.text must contain 1 to 1000 characters`);
    }
    if (
      !Number.isInteger(phrase.pauseAfterMs)
      || phrase.pauseAfterMs < 0
      || phrase.pauseAfterMs > 1500
    ) {
      fail(`${path}.pauseAfterMs must be an integer from 0 to 1500`);
    }
    if (!isPlainObject(phrase.visual)) fail(`${path}.visual must be an object`);
    if (
      Object.prototype.hasOwnProperty.call(phrase.visual, "triggerToken")
      && phrase.visual.triggerToken !== null
      && (
        typeof phrase.visual.triggerToken !== "string"
        || phrase.visual.triggerToken.trim().length < 1
      )
    ) {
      fail(`${path}.visual.triggerToken must be a non-empty string or null`);
    }
    const visual = canonicalize(phrase.visual, `${path}.visual`);
    return {
      id: phrase.id,
      text: phrase.text.trim(),
      pauseAfterMs: phrase.pauseAfterMs,
      visual,
    };
  });

  return { id: input.id, phrases };
}

function weightedIntegerRanges(start, length, weights) {
  if (!Number.isInteger(start) || !Number.isInteger(length) || length < 1) {
    fail("timing range must contain at least one integer unit");
  }
  if (!Array.isArray(weights) || weights.length < 1) {
    fail("timing range requires at least one weight");
  }
  const safeWeights = weights.map((weight) => (
    Number.isFinite(weight) && weight > 0 ? weight : 1
  ));
  const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0);
  const guaranteed = length >= weights.length ? 1 : 0;
  const distributable = length - guaranteed * weights.length;
  let cumulativeWeight = 0;
  let cursor = start;
  return safeWeights.map((weight, index) => {
    cumulativeWeight += weight;
    const extraEnd = Math.floor(
      distributable * cumulativeWeight / totalWeight,
    );
    const end = index === safeWeights.length - 1
      ? start + length
      : start + guaranteed * (index + 1) + extraEnd;
    const range = { start: cursor, end: Math.max(cursor, end) };
    cursor = range.end;
    return range;
  });
}

function wordWeight(word) {
  return Math.max(
    1,
    Array.from(String(word).matchAll(/[\p{L}\p{N}]/gu)).length,
  );
}

export function allocateCalibrationWordTiming({
  phraseId,
  text,
  startSample,
  sampleCount,
  startFrame,
  endFrame,
  globalIndexStart = 0,
}) {
  const tokens = tokenizeCalibrationPhrase(text);
  if (tokens.length < 1) fail(`${phraseId} must contain at least one word`);
  if (!Number.isInteger(sampleCount) || sampleCount < tokens.length) {
    fail(`${phraseId} audio is too short for deterministic word timing`);
  }
  if (
    !Number.isInteger(startFrame)
    || !Number.isInteger(endFrame)
    || endFrame <= startFrame
  ) {
    fail(`${phraseId} must occupy at least one narration frame`);
  }
  const weights = tokens.map(wordWeight);
  const sampleRanges = weightedIntegerRanges(startSample, sampleCount, weights);
  const frameRanges = weightedIntegerRanges(
    startFrame,
    endFrame - startFrame,
    weights,
  );
  return tokens.map((token, localIndex) => ({
    phraseId,
    localIndex,
    globalIndex: globalIndexStart + localIndex,
    text: token,
    startSample: sampleRanges[localIndex].start,
    endSample: sampleRanges[localIndex].end,
    startFrame: frameRanges[localIndex].start,
    endFrame: frameRanges[localIndex].end,
  }));
}

function resolveTriggerFrame(phrase, words) {
  const rawTrigger = phrase.visual.triggerToken;
  if (rawTrigger === undefined || rawTrigger === null) return phrase.startFrame;
  const wanted = tokenizeCalibrationPhrase(rawTrigger)
    .map(normalizeComparableToken)
    .filter(Boolean);
  const available = words.map((word) => normalizeComparableToken(word.text));
  if (wanted.length < 1) {
    fail(`${phrase.id}.visual.triggerToken contains no searchable token`);
  }
  for (let index = 0; index <= available.length - wanted.length; index += 1) {
    if (wanted.every((token, offset) => available[index + offset] === token)) {
      return words[index].startFrame;
    }
  }
  fail(
    `${phrase.id}.visual.triggerToken "${rawTrigger}" does not occur in its text`,
  );
}

function boundedOutput(current, chunk) {
  if (current.length >= MAX_PROCESS_OUTPUT_BYTES) return current;
  return (
    current + chunk.toString("utf8")
  ).slice(0, MAX_PROCESS_OUTPUT_BYTES);
}

export function runCalibrationProcess(
  command,
  args,
  {
    input = null,
    timeoutMs = 300_000,
    spawnImpl = nodeSpawn,
  } = {},
) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      rejectPromise(
        new Error(`Calibration process could not start: ${error.message}`),
      );
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(new Error(`Calibration process timed out: ${command}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = boundedOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = boundedOutput(stderr, chunk);
    });
    child.on("error", (error) => {
      settle(new Error(`Calibration process failed to start: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (code !== 0) {
        settle(
          new Error(
            `Calibration process failed (${code ?? signal ?? "unknown"}): `
              + stderr.trim(),
          ),
        );
        return;
      }
      settle(null, { stdout, stderr });
    });
    child.stdin.on("error", () => {
      // A process may close its input after reporting its own bounded error.
    });
    child.stdin.end(input === null ? undefined : input);
  });
}

function parseNormalizedPcmWav(buffer) {
  if (
    !Buffer.isBuffer(buffer)
    || buffer.length < 44
    || buffer.toString("ascii", 0, 4) !== "RIFF"
    || buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    fail("ffmpeg output must be a RIFF/WAVE file");
  }
  let format = null;
  let pcm = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    if (dataEnd > buffer.length) fail("normalized WAV contains a truncated chunk");
    if (chunkId === "fmt " && chunkSize >= 16) {
      format = {
        codec: buffer.readUInt16LE(dataStart),
        channels: buffer.readUInt16LE(dataStart + 2),
        sampleRate: buffer.readUInt32LE(dataStart + 4),
        bitsPerSample: buffer.readUInt16LE(dataStart + 14),
      };
    } else if (chunkId === "data") {
      pcm = Buffer.from(buffer.subarray(dataStart, dataEnd));
    }
    offset = dataEnd + (chunkSize % 2);
  }
  if (
    !format
    || !pcm
    || format.codec !== 1
    || format.channels !== CALIBRATION_CHANNELS
    || format.sampleRate !== CALIBRATION_SAMPLE_RATE
    || format.bitsPerSample !== 16
    || pcm.length < PCM_BYTES_PER_SAMPLE
    || pcm.length % PCM_BYTES_PER_SAMPLE !== 0
  ) {
    fail("ffmpeg output must be 48 kHz mono PCM s16le");
  }
  return pcm;
}

export function encodeCalibrationPcmWav(pcm) {
  if (
    !Buffer.isBuffer(pcm)
    || pcm.length < PCM_BYTES_PER_SAMPLE
    || pcm.length % PCM_BYTES_PER_SAMPLE !== 0
  ) {
    fail("PCM payload must contain complete signed 16-bit samples");
  }
  if (pcm.length > 0xfffffff0) fail("PCM payload exceeds the WAV size limit");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CALIBRATION_CHANNELS, 22);
  header.writeUInt32LE(CALIBRATION_SAMPLE_RATE, 24);
  header.writeUInt32LE(
    CALIBRATION_SAMPLE_RATE * CALIBRATION_CHANNELS * PCM_BYTES_PER_SAMPLE,
    28,
  );
  header.writeUInt16LE(CALIBRATION_CHANNELS * PCM_BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function defaultSynthesizePhrase({
  phrase,
  outputPath,
  runtime,
  voiceId,
  language,
  speakingRate,
  runProcess,
}) {
  const { stdout } = await runProcess(
    runtime.pythonBin,
    [runtime.helperPath],
    {
      input: JSON.stringify({
        segments: [{
          text: phrase.text,
          speed: speakingRate,
          pauseAfterMs: 0,
        }],
        voice: voiceId,
        language,
        modelPath: runtime.modelPath,
        voicesPath: runtime.voicesPath,
        outputPath,
      }),
      timeoutMs: runtime.timeoutMs,
    },
  );
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error("Local Kokoro returned invalid JSON");
  }
  if (
    result.status !== "complete"
    || result.segmentCount !== 1
    || result.totalPauseMs !== 0
    || !existsSync(outputPath)
  ) {
    throw new Error("Local Kokoro did not produce one pause-free phrase");
  }
  return result;
}

async function defaultNormalizePhrase({
  inputPath,
  outputPath,
  ffmpegPath,
  timeoutMs,
  runProcess,
}) {
  await runProcess(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-i",
      inputPath,
      "-map_metadata",
      "-1",
      "-vn",
      "-ac",
      String(CALIBRATION_CHANNELS),
      "-ar",
      String(CALIBRATION_SAMPLE_RATE),
      "-c:a",
      "pcm_s16le",
      outputPath,
    ],
    { timeoutMs },
  );
  if (!existsSync(outputPath)) {
    throw new Error("ffmpeg did not produce normalized phrase audio");
  }
}

function normalizeRenderedPcm(result, phraseId) {
  const pcm = Buffer.isBuffer(result) ? result : result?.pcm;
  if (
    !Buffer.isBuffer(pcm)
    || pcm.length < PCM_BYTES_PER_SAMPLE
    || pcm.length % PCM_BYTES_PER_SAMPLE !== 0
  ) {
    fail(`dependency returned invalid PCM for ${phraseId}`);
  }
  return Buffer.from(pcm);
}

function zeroSamples(sampleCount) {
  return Buffer.alloc(sampleCount * PCM_BYTES_PER_SAMPLE);
}

function resolveOutputPath(id, requestedPath) {
  if (requestedPath !== undefined) {
    if (
      typeof requestedPath !== "string"
      || requestedPath.trim().length < 1
      || extname(requestedPath).toLocaleLowerCase("en-US") !== ".wav"
    ) {
      fail("options.outputPath must be a .wav path");
    }
    const outputPath = resolve(requestedPath);
    mkdirSync(dirname(outputPath), { recursive: true });
    return { outputPath, temporary: false };
  }
  const outputDirectory = mkdtempSync(
    join(tmpdir(), "shortsengine-calibration-audio-output-"),
  );
  return {
    outputPath: join(outputDirectory, `${id}.wav`),
    temporary: true,
  };
}

function validateBuildOptions(options) {
  if (!isPlainObject(options)) fail("options must be an object");
  const voiceId = options.voiceId ?? DEFAULT_VOICE_ID;
  const language = options.language ?? DEFAULT_LANGUAGE;
  const speakingRate = options.speakingRate ?? DEFAULT_SPEAKING_RATE;
  if (!KOKORO_VOICES.includes(voiceId)) fail("options.voiceId is unsupported");
  if (!["en", "en-us", "en-gb"].includes(language)) {
    fail("options.language is unsupported");
  }
  if (
    !Number.isFinite(speakingRate)
    || speakingRate < 0.5
    || speakingRate > 2
  ) {
    fail("options.speakingRate must be from 0.5 to 2");
  }
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  if (typeof ffmpegPath !== "string" || ffmpegPath.trim().length < 1) {
    fail("options.ffmpegPath must be a command path");
  }
  const processTimeoutMs = Number(options.processTimeoutMs ?? 300_000);
  if (!Number.isFinite(processTimeoutMs)) {
    fail("options.processTimeoutMs must be finite");
  }
  return {
    voiceId,
    language,
    speakingRate,
    ffmpegPath,
    outputPath: options.outputPath,
    env: options.env ?? process.env,
    processTimeoutMs: Math.max(1000, Math.min(600_000, processTimeoutMs)),
  };
}

export async function buildMechanismExplainerCalibrationAudio(
  input,
  options = {},
  dependencies = {},
) {
  const story = validateMechanismExplainerCalibrationInput(input);
  const settings = validateBuildOptions(options);
  if (!isPlainObject(dependencies)) fail("dependencies must be an object");
  const output = resolveOutputPath(story.id, settings.outputPath);
  const workDirectory = mkdtempSync(
    join(tmpdir(), "shortsengine-calibration-audio-work-"),
  );
  const runProcess = (command, args, processOptions) => (
    dependencies.runProcess
      ? dependencies.runProcess(command, args, processOptions)
      : runCalibrationProcess(command, args, {
        ...processOptions,
        spawnImpl: dependencies.spawnImpl ?? nodeSpawn,
      })
  );
  const runtime = dependencies.runtime ?? kokoroConfig(settings.env);
  const phrasePcm = [];
  const synthesisReports = [];
  const injectedPcm = typeof dependencies.renderPhrasePcm === "function";
  let completed = false;

  try {
    for (let index = 0; index < story.phrases.length; index += 1) {
      const phrase = story.phrases[index];
      if (injectedPcm) {
        const rendered = await dependencies.renderPhrasePcm({
          phrase: structuredClone(phrase),
          phraseIndex: index,
          sampleRate: CALIBRATION_SAMPLE_RATE,
          channels: CALIBRATION_CHANNELS,
          format: "pcm_s16le",
          voiceId: settings.voiceId,
          language: settings.language,
          speakingRate: settings.speakingRate,
        });
        phrasePcm.push(normalizeRenderedPcm(rendered, phrase.id));
        synthesisReports.push({ dependencyInjected: true });
        continue;
      }

      const sourcePath = join(workDirectory, `${index}-source.wav`);
      const normalizedPath = join(workDirectory, `${index}-normalized.wav`);
      const synthesizePhrase =
        dependencies.synthesizePhrase ?? defaultSynthesizePhrase;
      const normalizePhrase =
        dependencies.normalizePhrase ?? defaultNormalizePhrase;
      const report = await synthesizePhrase({
        phrase: structuredClone(phrase),
        phraseIndex: index,
        outputPath: sourcePath,
        runtime,
        voiceId: settings.voiceId,
        language: settings.language,
        speakingRate: settings.speakingRate,
        runProcess,
      });
      await normalizePhrase({
        phrase: structuredClone(phrase),
        phraseIndex: index,
        inputPath: sourcePath,
        outputPath: normalizedPath,
        ffmpegPath: settings.ffmpegPath,
        timeoutMs: settings.processTimeoutMs,
        runProcess,
      });
      phrasePcm.push(parseNormalizedPcmWav(readFileSync(normalizedPath)));
      synthesisReports.push(canonicalize(report ?? {}, "synthesisReport"));
    }

    const parts = [];
    const phrases = [];
    const words = [];
    let sampleCursor = 0;
    let frameCursor = 0;
    let globalWordIndex = 0;

    for (let index = 0; index < story.phrases.length; index += 1) {
      const sourcePhrase = story.phrases[index];
      const pcm = phrasePcm[index];
      const audioSampleCount = pcm.length / PCM_BYTES_PER_SAMPLE;
      const phraseStartSample = sampleCursor;
      const phraseStartFrame = frameCursor;
      const audioEndSample = phraseStartSample + audioSampleCount;
      const audioEndFrame = phraseStartFrame + Math.ceil(
        audioSampleCount / CALIBRATION_SAMPLES_PER_FRAME,
      );
      const pauseSampleCount = Math.round(
        CALIBRATION_SAMPLE_RATE * sourcePhrase.pauseAfterMs / 1000,
      );
      const pauseStartSample = audioEndSample;
      const pauseEndSample = pauseStartSample + pauseSampleCount;
      const alignmentPaddingSamples = (
        CALIBRATION_SAMPLES_PER_FRAME
        - (pauseEndSample % CALIBRATION_SAMPLES_PER_FRAME)
      ) % CALIBRATION_SAMPLES_PER_FRAME;
      const alignedEndSample = pauseEndSample + alignmentPaddingSamples;
      const alignedEndFrame =
        alignedEndSample / CALIBRATION_SAMPLES_PER_FRAME;

      const phraseWords = allocateCalibrationWordTiming({
        phraseId: sourcePhrase.id,
        text: sourcePhrase.text,
        startSample: phraseStartSample,
        sampleCount: audioSampleCount,
        startFrame: phraseStartFrame,
        endFrame: audioEndFrame,
        globalIndexStart: globalWordIndex,
      });
      const phrase = {
        index,
        id: sourcePhrase.id,
        text: sourcePhrase.text,
        visual: structuredClone(sourcePhrase.visual),
        startSample: phraseStartSample,
        startFrame: phraseStartFrame,
        endSample: alignedEndSample,
        endFrame: alignedEndFrame,
        triggerFrame: null,
        audio: {
          startSample: phraseStartSample,
          endSample: audioEndSample,
          sampleCount: audioSampleCount,
          startFrame: phraseStartFrame,
          endFrame: audioEndFrame,
          sha256: sha256(pcm),
        },
        pause: {
          requestedMs: sourcePhrase.pauseAfterMs,
          startSample: pauseStartSample,
          endSample: pauseEndSample,
          sampleCount: pauseSampleCount,
          startFrame: audioEndFrame,
          endFrame: Math.ceil(
            pauseEndSample / CALIBRATION_SAMPLES_PER_FRAME,
          ),
        },
        alignmentPaddingSamples,
        words: phraseWords,
      };
      phrase.triggerFrame = resolveTriggerFrame(phrase, phraseWords);
      parts.push(pcm);
      if (pauseSampleCount > 0) parts.push(zeroSamples(pauseSampleCount));
      if (alignmentPaddingSamples > 0) {
        parts.push(zeroSamples(alignmentPaddingSamples));
      }
      phrases.push(phrase);
      words.push(...phraseWords);
      sampleCursor = alignedEndSample;
      frameCursor = alignedEndFrame;
      globalWordIndex += phraseWords.length;
    }

    const speechEndSample = phrases.at(-1).audio.endSample;
    const speechEndFrame = phrases.at(-1).audio.endFrame;
    const finalHoldStartSample = sampleCursor;
    const finalHoldStartFrame = frameCursor;
    const finalHoldSampleCount =
      CALIBRATION_FINAL_HOLD_FRAMES * CALIBRATION_SAMPLES_PER_FRAME;
    parts.push(zeroSamples(finalHoldSampleCount));
    sampleCursor += finalHoldSampleCount;
    frameCursor += CALIBRATION_FINAL_HOLD_FRAMES;
    const finalPhrase = phrases.at(-1);
    finalPhrase.endSample = sampleCursor;
    finalPhrase.endFrame = frameCursor;
    finalPhrase.finalHold = {
      startSample: finalHoldStartSample,
      endSample: sampleCursor,
      sampleCount: finalHoldSampleCount,
      startFrame: finalHoldStartFrame,
      endFrame: frameCursor,
      frameCount: CALIBRATION_FINAL_HOLD_FRAMES,
    };

    const finalPcm = Buffer.concat(parts);
    if (finalPcm.length / PCM_BYTES_PER_SAMPLE !== sampleCursor) {
      throw new Error("Calibration PCM assembly violated the sample clock");
    }
    const wav = encodeCalibrationPcmWav(finalPcm);
    writeFileSync(output.outputPath, wav);
    const audioSha256 = sha256(wav);
    const inputSha256 = sha256(canonicalJson(story));
    const durationSeconds = Number(
      (sampleCursor / CALIBRATION_SAMPLE_RATE).toFixed(6),
    );
    const provenance = {
      profile: MECHANISM_EXPLAINER_CALIBRATION_AUDIO_PROFILE,
      purpose: "quality_calibration_only",
      calibration: true,
      publishable: false,
      rightsStatus: "commercial_use_not_attested",
      commercialUseAttested: false,
      commercialUseAttestation: null,
      provider: injectedPcm ? "dependency_injected_pcm" : "kokoro_local",
      providerExecution: injectedPcm
        ? "injected_test_boundary"
        : "one_helper_spawn_per_phrase",
      providerProcessShell: injectedPcm ? null : false,
      modelId: injectedPcm ? null : KOKORO_MODEL_ID,
      runtimeVersion: injectedPcm ? null : KOKORO_RUNTIME_VERSION,
      voiceId: settings.voiceId,
      language: settings.language,
      speakingRate: settings.speakingRate,
      licenseReference: injectedPcm ? null : KOKORO_LICENSE_REFERENCE,
      normalization: {
        tool: injectedPcm ? "injected_pcm_contract" : "ffmpeg",
        sampleRate: CALIBRATION_SAMPLE_RATE,
        channels: CALIBRATION_CHANNELS,
        codec: "pcm_s16le",
      },
      inputSha256,
      audioSha256,
      synthesisReports,
    };

    const result = {
      schemaVersion: 1,
      id: story.id,
      profile: MECHANISM_EXPLAINER_CALIBRATION_AUDIO_PROFILE,
      normalizedAudioPath: output.outputPath,
      normalizedAudioPathTemporary: output.temporary,
      durationFrames: frameCursor,
      durationSamples: sampleCursor,
      durationSeconds,
      speechEndFrame,
      speechEndSample,
      sampleRate: CALIBRATION_SAMPLE_RATE,
      channels: CALIBRATION_CHANNELS,
      fps: CALIBRATION_FPS,
      samplesPerFrame: CALIBRATION_SAMPLES_PER_FRAME,
      audioSha256,
      phrases,
      words,
      frameClock: {
        fps: CALIBRATION_FPS,
        sampleRate: CALIBRATION_SAMPLE_RATE,
        samplesPerFrame: CALIBRATION_SAMPLES_PER_FRAME,
        durationFrames: frameCursor,
        durationSamples: sampleCursor,
        speechEndFrame,
        speechEndSample,
        finalHold: {
          startSample: finalHoldStartSample,
          endSample: sampleCursor,
          sampleCount: finalHoldSampleCount,
          startFrame: finalHoldStartFrame,
          endFrame: frameCursor,
          frameCount: CALIBRATION_FINAL_HOLD_FRAMES,
        },
      },
      provenance,
      calibration: true,
      publishable: false,
      commercialUseAttested: false,
      commercialUseAttestation: null,
      releaseBlockers: [
        "CALIBRATION_ONLY",
        "COMMERCIAL_USE_ATTESTATION_REQUIRED",
      ],
    };
    completed = true;
    return result;
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
    if (!completed && output.temporary) {
      rmSync(dirname(output.outputPath), { recursive: true, force: true });
    }
  }
}
