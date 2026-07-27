"use strict";

const { contentHash } = require("../contracts.cjs");

function luminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map((value) => {
    const channel = Number.parseInt(value, 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(left, right) {
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return Number(((values[0] + 0.05) / (values[1] + 0.05)).toFixed(3));
}

function runEducationalPerceptualQa(compiled) {
  if (!compiled?.referenceStyleSpec) {
    return Object.freeze({
      schemaVersion: 1,
      applicable: false,
      status: "not_applicable",
    });
  }
  const style = compiled.referenceStyleSpec;
  const graph = compiled.narrativeBeatGraph;
  const director = compiled.directorPlan;
  const ir = compiled.animationIR;
  const eventGaps = director.visualEvents.slice(1).map(
    (event, index) => (
      event.frame - director.visualEvents[index].frame
    ) / graph.fps,
  );
  const checks = {
    promiseVisibleFromFrameZero:
      director.promise.persistentFromFrame === 0
      && ir.sharedEntities.some((entity) => entity.id === "promise_header"),
    overviewCompleteByThreeSeconds:
      style.pacing.overviewCompleteBySeconds <= 3,
    firstSectionBySixSeconds:
      graph.sections[0].startFrame <= graph.fps * 6,
    meaningfulChangeCadence:
      eventGaps.length > 0
      && Math.max(...eventGaps) <= style.pacing.meaningfulChangeMaxSeconds,
    exactNarrationAnchors:
      graph.microbeats.every((microbeat) => (
        Number.isInteger(microbeat.startFrame)
        && Number.isInteger(microbeat.endFrame)
        && microbeat.endFrame > microbeat.startFrame
      )),
    primaryTextContrast:
      contrast(style.palette.primary, style.palette.background) >= 4.5,
    accentContrast:
      contrast(style.palette.accent, style.palette.background) >= 3,
    persistentEntityContinuity:
      ir.scenes.every((scene) => (
        scene.entityIds.includes("promise_header")
        && scene.entityIds.includes("story_thread")
      )),
    rightsAndProvenance:
      compiled.assetManifest.assets.every((asset) => (
        asset.commercialUseAllowed === true
        && ["licensed_local", "generated_by_engine"].includes(asset.origin)
      )),
    deterministicBindings:
      director.bindings.styleSpecHash === style.contentHash
      && director.bindings.beatGraphHash === graph.contentHash
      && compiled.audioIR.assetManifestHash === compiled.assetManifest.contentHash,
  };
  const status = Object.values(checks).every(Boolean) ? "passed" : "failed";
  const body = {
    schemaVersion: 1,
    applicable: true,
    profile: "educational_perceptual_qa_v1",
    status,
    checks,
    metrics: {
      primaryTextContrast: contrast(style.palette.primary, style.palette.background),
      accentContrast: contrast(style.palette.accent, style.palette.background),
      maximumVisualEventGapSeconds: Number(Math.max(...eventGaps).toFixed(3)),
      microbeatCount: graph.microbeats.length,
      visualEventCount: director.visualEvents.length,
      persistentEntityCount: 2,
    },
    bindings: {
      animationIRHash: ir.contentHash,
      referenceStyleSpecHash: style.contentHash,
      narrativeBeatGraphHash: graph.contentHash,
      directorPlanHash: director.contentHash,
      audioIRHash: compiled.audioIR.contentHash,
      assetManifestHash: compiled.assetManifest.contentHash,
    },
  };
  return Object.freeze({ ...body, contentHash: contentHash(body) });
}

module.exports = { contrast, runEducationalPerceptualQa };
