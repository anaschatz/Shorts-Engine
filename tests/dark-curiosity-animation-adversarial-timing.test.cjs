const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runAdversarialTimingValidation } = require("../server/pipelines/narrated-short/animation/adversarial-timing.cjs");
const { validateBrowserSeekProof } = require("../server/pipelines/narrated-short/animation/browser-seek-proof.cjs");

const fixtureDir = join(__dirname, "../eval/narrated/dark-curiosity/animation");
const json = (name) => JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));

test("thirteen adversarial timing plans fail before render with bounded stable codes", () => {
  const result = runAdversarialTimingValidation({ plan: json("002_wow_signal_semantic_plan.json"), timingContext: json("002_wow_signal_timing_context.json") });
  assert.equal(result.caseCount, 13);
  assert.equal(result.passedCount, 13);
  assert.equal(result.renderAttemptCount, 0);
  assert.equal(result.partialArtifactCount, 0);
  assert.equal(result.passed, true);
  assert.equal(new Set(result.cases.map((entry) => entry.id)).size, 13);
  assert.doesNotMatch(JSON.stringify(result), /\/Users|raw|stack|provider|narration/i);
});

test("browser seek manifest is strict, canonical and tamper-evident", () => {
  const adversarial = runAdversarialTimingValidation({ plan: json("002_wow_signal_semantic_plan.json"), timingContext: json("002_wow_signal_timing_context.json") });
  const seekSequence = [27, 76, 27, 209, 76, 241, 209, 291, 241, 291];
  const frameHash = (frame) => String(frame).padStart(64, "0").slice(-64);
  const input = {
    schemaVersion: 1,
    profile: "dark_curiosity_browser_seek_proof_v1",
    animationIRHash: "a".repeat(64), timingContextHash: "b".repeat(64), compositionHash: "c".repeat(64),
    provider: "hyperframes_benchmark", runtimeVersion: "0.7.55", styleSystemVersion: "1.1.0", templateVersions: { signal_lab_v1: "1.1.0", mystery_payoff_v1: "1.1.0" },
    seekSequence,
    captures: seekSequence.map((frame, sequenceIndex) => ({ sequenceIndex, frame, sha256: frameHash(frame) })),
    repeatedFrames: [27, 76, 209, 241, 291].map((frame) => ({ frame, occurrences: 2, sha256: frameHash(frame), equal: true })),
    browser: { loadedOnce: true, pageLoadCount: 1, stateIsolation: { valid: true, wallClockIndependent: true, seededRandomOnly: true, autoplayFree: true, frameAccumulationFree: true }, externalRequestCount: 0, blockedExternalRequestCount: 0, resourceClasses: [] },
    networkProbe: { errorCode: "BROWSER_EXTERNAL_REQUEST_BLOCKED", externalRequestCount: 1, blockedExternalRequestCount: 1, resourceClasses: [{ resourceClass: "image", count: 1 }], passed: true },
    adversarial,
    repeatRender: { timingContextHashEqual: true, animationIRHashEqual: true, compositionHashEqual: true, checkpointHashesEqual: true, browserSeekHashesEqual: true, technicalMetadataEqual: true, mp4Sha256Equal: true, firstOutputSha256: "d".repeat(64), secondOutputSha256: "d".repeat(64), passed: true },
    passed: true, warnings: [],
  };
  const first = validateBrowserSeekProof(input);
  const second = validateBrowserSeekProof(input);
  assert.equal(first.contentHash, second.contentHash);
  const unknown = structuredClone(input); unknown.rawBrowserLog = "unsafe";
  assert.throws(() => validateBrowserSeekProof(unknown), { code: "ANIMATION_BROWSER_SEEK_PROOF_INVALID" });
  const tampered = structuredClone(first); tampered.captures[0].sha256 = "e".repeat(64);
  assert.throws(() => validateBrowserSeekProof(tampered), { code: "ANIMATION_BROWSER_SEEK_PROOF_INVALID" });
});
