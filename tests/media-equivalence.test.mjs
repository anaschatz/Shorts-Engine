import test from "node:test";
import assert from "node:assert/strict";

import { MEDIA_EQUIVALENCE_THRESHOLDS, assessMediaEquivalence, parsePsnrSummary, parseSsimSummary } from "../tools/lib/media-equivalence.mjs";

const probe = Object.freeze({
  streams: [
    { index: 0, codecType: "video", codecName: "h264", width: 1080, height: 1920, pixelFormat: "yuv420p", frameRate: "30/1", averageFrameRate: "30/1", timeBase: "1/15360", startTime: "0.000000", frameCount: "1263", durationTimestamp: "646656", duration: "42.100000", sampleRate: null, channels: null, channelLayout: null },
    { index: 1, codecType: "audio", codecName: "aac", width: null, height: null, pixelFormat: null, frameRate: "0/0", averageFrameRate: "0/0", timeBase: "1/48000", startTime: "0.000000", frameCount: "1975", durationTimestamp: "2020704", duration: "42.098000", sampleRate: "48000", channels: 1, channelLayout: "mono" },
  ],
  startTime: "0.000000",
  duration: "42.100000",
});

function candidate(overrides = {}) {
  return {
    firstProbe: probe,
    secondProbe: structuredClone(probe),
    firstAudioHash: "a".repeat(64),
    secondAudioHash: "a".repeat(64),
    firstTimelineHash: "b".repeat(64),
    secondTimelineHash: "b".repeat(64),
    psnr: { averageDb: 61.745241, minimumDb: 51.535083 },
    ssim: 0.999819,
    ...overrides,
  };
}

test("media equivalence parsers read strict ffmpeg summary values", () => {
  assert.deepEqual(parsePsnrSummary("[Parsed_psnr_0] PSNR y:60.911290 u:64.796309 v:63.563830 average:61.745241 min:51.535083 max:inf"), { averageDb: 61.745241, minimumDb: 51.535083 });
  assert.equal(parseSsimSummary("[Parsed_ssim_0] SSIM Y:0.999829 (37.680009) U:0.999785 (36.670506) V:0.999811 (37.238869) All:0.999819 (37.421083)"), 0.999819);
  assert.deepEqual(parsePsnrSummary("PSNR y:inf u:inf v:inf average:inf min:inf max:inf"), { averageDb: Number.POSITIVE_INFINITY, minimumDb: Number.POSITIVE_INFINITY });
});

test("imperceptible codec drift passes the fail-closed production thresholds", () => {
  const result = assessMediaEquivalence(candidate());
  assert.equal(result.passed, true);
  assert.deepEqual(result.thresholds, MEDIA_EQUIVALENCE_THRESHOLDS);
});

test("audio or technical metadata drift fails media equivalence", () => {
  assert.equal(assessMediaEquivalence(candidate({ secondAudioHash: "b".repeat(64) })).passed, false);
  assert.equal(assessMediaEquivalence(candidate({ secondTimelineHash: "c".repeat(64) })).passed, false);
  const changedProbe = structuredClone(probe);
  changedProbe.streams[0].frameCount = "1262";
  assert.equal(assessMediaEquivalence(candidate({ secondProbe: changedProbe })).passed, false);
});

test("visible frame drift fails PSNR and SSIM gates", () => {
  assert.equal(assessMediaEquivalence(candidate({ psnr: { averageDb: 59.99, minimumDb: 51 }, ssim: 0.9999 })).passed, false);
  assert.equal(assessMediaEquivalence(candidate({ psnr: { averageDb: 62, minimumDb: 49.99 }, ssim: 0.9999 })).passed, false);
  assert.equal(assessMediaEquivalence(candidate({ psnr: { averageDb: 62, minimumDb: 52 }, ssim: 0.99979 })).passed, false);
});

test("malformed ffmpeg metric output is rejected", () => {
  assert.throws(() => parsePsnrSummary("no psnr summary"), /media_equivalence_psnr_missing/);
  assert.throws(() => parseSsimSummary("no ssim summary"), /media_equivalence_ssim_missing/);
});
