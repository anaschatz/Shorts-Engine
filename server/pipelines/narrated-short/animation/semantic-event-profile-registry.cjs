"use strict";

const { createHash } = require("node:crypto");

const { AppError } = require("../../../errors.cjs");
const gpsManifestInput = require("../../../../eval/narrated/dark-curiosity/semantic-events/002_gps_week_rollover.json");
const baychimoManifestInput = require("../../../../eval/narrated/dark-curiosity/semantic-events/003_baychimo_icebound_drift.json");
const gpsTimingInput = require("../../../../eval/narrated/dark-curiosity/semantic-events/timing/002_gps_week_rollover.timing.json");
const baychimoTimingInput = require("../../../../eval/narrated/dark-curiosity/semantic-events/timing/003_baychimo_icebound_drift.timing.json");
const { stableStringify } = require("./canonical-json.cjs");
const { deepFreeze } = require("./semantic-event-validator.cjs");
const {
  SEMANTIC_SENTENCE_PROFILE_ID,
} = require("./semantic-render-profile.cjs");
const {
  normalizeAnimationTimingContext,
} = require("./timing-contract.cjs");

const HASH_PATTERN = /^[a-f0-9]{64}$/;

function fail(field, reason) {
  throw new AppError(
    "ANIMATION_SEMANTIC_PROFILE_UNSUPPORTED",
    "No approved semantic event profile matches this draft and narration alignment.",
    409,
    { field, reason },
  );
}

function canonicalHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function registryKey(profileId, draftHash, alignmentHash) {
  return `${profileId}\u0000${draftHash}\u0000${alignmentHash}`;
}

function checkedProfile(id, manifestInput, timingInput) {
  const manifest = deepFreeze(structuredClone(manifestInput));
  const timingContext = deepFreeze(structuredClone(
    normalizeAnimationTimingContext(timingInput),
  ));
  if (
    manifest?.schemaVersion !== 3
    || manifest?.artifactType !== "semantic_event_graph"
    || manifest?.sourceBindings?.approvedDraftHash !== timingContext.draftHash
    || manifest?.sourceBindings?.alignmentHash !== timingContext.alignmentHash
    || manifest?.sourceBindings?.fps !== timingContext.fps
    || manifest?.sourceBindings?.durationFrames !== timingContext.durationFrames
    || manifest?.sourceBindings?.wordCount !== timingContext.words.length
  ) {
    fail(`registry.${id}`, "checked_in_profile_binding_invalid");
  }
  return deepFreeze({
    id,
    profileId: SEMANTIC_SENTENCE_PROFILE_ID,
    draftHash: timingContext.draftHash,
    alignmentHash: timingContext.alignmentHash,
    timingContextHash: timingContext.contentHash,
    manifestHash: canonicalHash(manifest),
    manifest,
    timingContext,
  });
}

const PROFILES = Object.freeze([
  checkedProfile(
    "gps_week_rollover_v3",
    gpsManifestInput,
    gpsTimingInput,
  ),
  checkedProfile(
    "baychimo_icebound_drift_v3",
    baychimoManifestInput,
    baychimoTimingInput,
  ),
]);

const PROFILE_BY_KEY = new Map(PROFILES.map((entry) => [
  registryKey(entry.profileId, entry.draftHash, entry.alignmentHash),
  entry,
]));

function resolveSemanticEventProfile(input = {}) {
  const { profileId, draftHash, alignmentHash } = input;
  if (profileId !== SEMANTIC_SENTENCE_PROFILE_ID) {
    fail("profileId", "profile_id_not_allowlisted");
  }
  if (typeof draftHash !== "string" || !HASH_PATTERN.test(draftHash)) {
    fail("draftHash", "hash_required");
  }
  if (typeof alignmentHash !== "string" || !HASH_PATTERN.test(alignmentHash)) {
    fail("alignmentHash", "hash_required");
  }
  const profile = PROFILE_BY_KEY.get(registryKey(profileId, draftHash, alignmentHash));
  if (!profile) fail("profile", "exact_profile_binding_not_found");
  return profile;
}

function listSemanticEventProfiles() {
  return deepFreeze(PROFILES.map((entry) => ({
    id: entry.id,
    profileId: entry.profileId,
    draftHash: entry.draftHash,
    alignmentHash: entry.alignmentHash,
    timingContextHash: entry.timingContextHash,
    manifestHash: entry.manifestHash,
  })));
}

module.exports = {
  listSemanticEventProfiles,
  resolveSemanticEventProfile,
};
