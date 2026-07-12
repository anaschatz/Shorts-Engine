const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { normalizeAlignment } = require("../narration/alignment.cjs");
const { normalizeNarrationAsset } = require("../narration/contract.cjs");
const { normalizeCaptionManifest } = require("../captions/contract.cjs");
const { normalizeAudioNormalizationReport } = require("../audio-normalization.cjs");
const { createQaReport } = require("./contract.cjs");
const { runContentQa } = require("./content-qa.cjs");
const { runRightsQa } = require("./rights-qa.cjs");
const { runAudioQa } = require("./audio-qa.cjs");
const { runCaptionQa } = require("./caption-qa.cjs");
const { runTimelineQa } = require("./timeline-qa.cjs");
const { analyzeRenderedVideo, runRenderedVideoQa } = require("./rendered-video-qa.cjs");

async function runQaOrchestrator(input = {}, dependencies = {}) {
  try {
    const alignment = normalizeAlignment(input.alignment);
    const narration = normalizeNarrationAsset(input.narration);
    const caption = normalizeCaptionManifest(input.caption, { alignment });
    const normalization = normalizeAudioNormalizationReport(input.normalization);
    const analyzer = dependencies.analyzeRenderedVideo || analyzeRenderedVideo;
    const analysis = await analyzer({ outputPath: input.outputPath, timeline: input.timeline, renderProfile: input.renderProfile, signal: input.signal, ffprobeImpl: dependencies.ffprobeJson, ffmpegRunner: dependencies.ffmpegRunner });
    const gates = [
      ...runContentQa({ project: input.project, approval: input.approval, draftEnvelope: input.draftEnvelope, draft: input.draft }),
      ...runRightsQa({ narration, active: input.active, audioArtifact: input.audioArtifact }),
      ...runAudioQa({ active: input.active, alignment, normalization, renderResult: input.renderResult, media: narration.media }),
      ...runCaptionQa({ alignment, caption, captionAssArtifact: input.captionAssArtifact, renderResult: input.renderResult, fontAvailable: input.fontAvailable }),
      ...runTimelineQa({ timeline: input.timeline, timelineArtifact: input.timelineArtifact, alignment, caption }),
      ...runRenderedVideoQa({ analysis, timeline: input.timeline, renderProfile: input.renderProfile }),
    ];
    const bindings = {
      draftArtifactId: input.draftEnvelope.artifactId, draftHash: input.draftEnvelope.contentHash, scriptHash: input.draft.script.contentHash,
      narrationManifestArtifactId: input.active.manifestArtifactId, narrationManifestHash: input.active.manifestHash,
      audioArtifactId: input.active.audioArtifactId, audioHash: input.active.audioHash,
      alignmentArtifactId: input.active.alignmentArtifactId, alignmentHash: input.active.alignmentHash,
      captionManifestArtifactId: input.captionManifestArtifact.artifact.id, captionManifestHash: input.captionManifestArtifact.envelope.contentHash,
      captionAssArtifactId: input.captionAssArtifact.id, captionAssHash: input.captionAssArtifact.checksumSha256,
      audioNormalizationReportArtifactId: input.normalizationArtifact.artifact.id, audioNormalizationReportHash: input.normalizationArtifact.envelope.contentHash,
      timelineArtifactId: input.timelineArtifact.artifact.id, timelineHash: input.timeline.contentHash,
      outputHash: input.outputHash,
    };
    return { report: createQaReport({ projectId: input.project.id, projectRevision: input.project.input.revision, renderProfile: input.renderProfile, bindings, gates }), analysis };
  } catch (error) {
    if (error && error.code === "JOB_CANCELLED") throw error;
    if (error && error.code === "QA_REPORT_INVALID") throw error;
    throw new AppError("QA_EXECUTION_FAILED", SAFE_MESSAGES.QA_EXECUTION_FAILED, 409);
  }
}

function publicQaSummary(report, artifact = null) {
  const failedGateCodes = report.gates.filter((gate) => gate.severity === "blocking" && !gate.passed).map((gate) => gate.code).slice(0, 24);
  return { status: report.status, decision: report.decision, qaPassed: report.status === "passed", renderProfile: report.renderProfile, qaProfile: report.qaProfile, qaProfileVersion: report.qaProfileVersion, qaReportArtifactId: artifact && artifact.artifact && artifact.artifact.id || null, qaReportHash: artifact && artifact.envelope && artifact.envelope.contentHash || report.contentHash, blockingGateCount: report.summary.blockingGateCount, blockingPassedCount: report.summary.blockingPassedCount, blockingFailedCount: report.summary.blockingFailedCount, warningCount: report.summary.warningCount, failedGateCodes, outputHash: report.bindings.outputHash };
}

module.exports = { publicQaSummary, runQaOrchestrator };
