const { createHash } = require("node:crypto");
const { AppError } = require("../../../errors.cjs");
const { stableStringify } = require("./contract.cjs");

const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z][a-z0-9_-]{2,79}$/;
const ERROR_RE = /^[A-Z][A-Z0-9_]{2,79}$/;

function fail(field) { throw new AppError("ANIMATION_BROWSER_SEEK_PROOF_INVALID", "Animation browser seek proof is invalid.", 400, { field }); }
function object(value, field) { if (!value || typeof value !== "object" || Array.isArray(value)) fail(field); return value; }
function exact(value, keys, field) { const allowed = new Set(keys); for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field}.${key}`); }
function integer(value, field, min = 0, max = 1_000_000) { if (!Number.isInteger(value) || value < min || value > max) fail(field); return value; }
function bool(value, field) { if (typeof value !== "boolean") fail(field); return value; }
function text(value, field, pattern, max = 80) { if (typeof value !== "string" || !value || value.length > max || !pattern.test(value)) fail(field); return value; }
function hash(value, field) { return text(value, field, HASH_RE, 64); }

function proofContentHash(value) {
  const copy = structuredClone(value);
  delete copy.contentHash;
  return createHash("sha256").update(stableStringify(copy)).digest("hex");
}

function validateBrowserSeekProof(input) {
  const proof = structuredClone(object(input, "proof"));
  exact(proof, ["schemaVersion", "profile", "animationIRHash", "timingContextHash", "compositionHash", "provider", "runtimeVersion", "styleSystemVersion", "templateVersions", "seekSequence", "captures", "repeatedFrames", "browser", "networkProbe", "adversarial", "repeatRender", "passed", "warnings", "contentHash"], "proof");
  if (proof.schemaVersion !== 1 || proof.profile !== "dark_curiosity_browser_seek_proof_v1") fail("profile");
  ["animationIRHash", "timingContextHash", "compositionHash"].forEach((key) => hash(proof[key], key));
  text(proof.provider, "provider", ID_RE); text(proof.runtimeVersion, "runtimeVersion", /^\d+\.\d+\.\d+$/); text(proof.styleSystemVersion, "styleSystemVersion", /^\d+\.\d+\.\d+$/);
  object(proof.templateVersions, "templateVersions");
  for (const [key, value] of Object.entries(proof.templateVersions)) { text(key, `templateVersions.${key}`, ID_RE); text(value, `templateVersions.${key}`, /^\d+\.\d+\.\d+$/); }
  if (!Array.isArray(proof.seekSequence) || proof.seekSequence.length < 10 || proof.seekSequence.length > 40) fail("seekSequence");
  proof.seekSequence.forEach((frame, index) => integer(frame, `seekSequence[${index}]`, 0, 3599));
  if (!Array.isArray(proof.captures) || proof.captures.length !== proof.seekSequence.length) fail("captures");
  proof.captures.forEach((capture, index) => { object(capture, `captures[${index}]`); exact(capture, ["sequenceIndex", "frame", "sha256"], `captures[${index}]`); if (capture.sequenceIndex !== index || capture.frame !== proof.seekSequence[index]) fail(`captures[${index}]`); hash(capture.sha256, `captures[${index}].sha256`); });
  if (!Array.isArray(proof.repeatedFrames) || proof.repeatedFrames.length < 5) fail("repeatedFrames");
  proof.repeatedFrames.forEach((entry, index) => { object(entry, `repeatedFrames[${index}]`); exact(entry, ["frame", "occurrences", "sha256", "equal"], `repeatedFrames[${index}]`); integer(entry.frame, `repeatedFrames[${index}].frame`, 0, 3599); integer(entry.occurrences, `repeatedFrames[${index}].occurrences`, 2, 40); hash(entry.sha256, `repeatedFrames[${index}].sha256`); if (!bool(entry.equal, `repeatedFrames[${index}].equal`)) fail(`repeatedFrames[${index}].equal`); });
  object(proof.browser, "browser"); exact(proof.browser, ["loadedOnce", "pageLoadCount", "stateIsolation", "externalRequestCount", "blockedExternalRequestCount", "resourceClasses"], "browser");
  if (!bool(proof.browser.loadedOnce, "browser.loadedOnce") || integer(proof.browser.pageLoadCount, "browser.pageLoadCount", 1, 1) !== 1) fail("browser.loadedOnce");
  object(proof.browser.stateIsolation, "browser.stateIsolation"); exact(proof.browser.stateIsolation, ["valid", "wallClockIndependent", "seededRandomOnly", "autoplayFree", "frameAccumulationFree"], "browser.stateIsolation"); for (const [key, value] of Object.entries(proof.browser.stateIsolation)) if (!bool(value, `browser.stateIsolation.${key}`)) fail(`browser.stateIsolation.${key}`);
  if (integer(proof.browser.externalRequestCount, "browser.externalRequestCount", 0, 0) !== 0 || integer(proof.browser.blockedExternalRequestCount, "browser.blockedExternalRequestCount", 0, 0) !== 0) fail("browser.externalRequestCount");
  if (!Array.isArray(proof.browser.resourceClasses) || proof.browser.resourceClasses.length) fail("browser.resourceClasses");
  object(proof.networkProbe, "networkProbe"); exact(proof.networkProbe, ["errorCode", "externalRequestCount", "blockedExternalRequestCount", "resourceClasses", "passed"], "networkProbe"); text(proof.networkProbe.errorCode, "networkProbe.errorCode", ERROR_RE); integer(proof.networkProbe.externalRequestCount, "networkProbe.externalRequestCount", 1, 20); integer(proof.networkProbe.blockedExternalRequestCount, "networkProbe.blockedExternalRequestCount", 1, 20); if (!Array.isArray(proof.networkProbe.resourceClasses) || !proof.networkProbe.resourceClasses.length) fail("networkProbe.resourceClasses"); proof.networkProbe.resourceClasses.forEach((entry, index) => { object(entry, `networkProbe.resourceClasses[${index}]`); exact(entry, ["resourceClass", "count"], `networkProbe.resourceClasses[${index}]`); text(entry.resourceClass, `networkProbe.resourceClasses[${index}].resourceClass`, ID_RE); integer(entry.count, `networkProbe.resourceClasses[${index}].count`, 1, 20); }); if (!bool(proof.networkProbe.passed, "networkProbe.passed")) fail("networkProbe.passed");
  object(proof.adversarial, "adversarial"); exact(proof.adversarial, ["caseCount", "passedCount", "cases", "renderAttemptCount", "partialArtifactCount", "passed"], "adversarial"); integer(proof.adversarial.caseCount, "adversarial.caseCount", 10, 30); if (integer(proof.adversarial.passedCount, "adversarial.passedCount", 10, 30) !== proof.adversarial.caseCount || integer(proof.adversarial.renderAttemptCount, "adversarial.renderAttemptCount", 0, 0) !== 0 || integer(proof.adversarial.partialArtifactCount, "adversarial.partialArtifactCount", 0, 0) !== 0 || !bool(proof.adversarial.passed, "adversarial.passed")) fail("adversarial"); if (!Array.isArray(proof.adversarial.cases) || proof.adversarial.cases.length !== proof.adversarial.caseCount) fail("adversarial.cases"); proof.adversarial.cases.forEach((entry, index) => { object(entry, `adversarial.cases[${index}]`); exact(entry, ["id", "expectedCode", "actualCode", "passed", "renderAttempted"], `adversarial.cases[${index}]`); text(entry.id, `adversarial.cases[${index}].id`, ID_RE); text(entry.expectedCode, `adversarial.cases[${index}].expectedCode`, ERROR_RE); text(entry.actualCode, `adversarial.cases[${index}].actualCode`, ERROR_RE); if (!bool(entry.passed, `adversarial.cases[${index}].passed`) || bool(entry.renderAttempted, `adversarial.cases[${index}].renderAttempted`)) fail(`adversarial.cases[${index}]`); });
  object(proof.repeatRender, "repeatRender"); exact(proof.repeatRender, ["timingContextHashEqual", "animationIRHashEqual", "compositionHashEqual", "checkpointHashesEqual", "browserSeekHashesEqual", "technicalMetadataEqual", "mp4Sha256Equal", "firstOutputSha256", "secondOutputSha256", "passed"], "repeatRender"); for (const key of ["timingContextHashEqual", "animationIRHashEqual", "compositionHashEqual", "checkpointHashesEqual", "browserSeekHashesEqual", "technicalMetadataEqual", "mp4Sha256Equal", "passed"]) if (!bool(proof.repeatRender[key], `repeatRender.${key}`)) fail(`repeatRender.${key}`); hash(proof.repeatRender.firstOutputSha256, "repeatRender.firstOutputSha256"); hash(proof.repeatRender.secondOutputSha256, "repeatRender.secondOutputSha256");
  if (!bool(proof.passed, "passed")) fail("passed");
  if (!Array.isArray(proof.warnings) || proof.warnings.length > 8 || proof.warnings.some((warning) => typeof warning !== "string" || warning.length > 80 || !ID_RE.test(warning))) fail("warnings");
  const expected = proofContentHash(proof); if (proof.contentHash !== undefined && proof.contentHash !== expected) fail("contentHash"); proof.contentHash = expected;
  return Object.freeze(proof);
}

module.exports = { proofContentHash, validateBrowserSeekProof };
