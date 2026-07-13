const { normalizeDraftBundle, contentHash } = require("../contracts.cjs");
const { normalizeAlignment } = require("../narration/alignment.cjs");
const { buildProductionTimingContext } = require("./timing-context-builder.cjs");
const { compileProductionAnimation, PRODUCTION_PROVIDER_ID, PRODUCTION_RUNTIME_VERSION, PRODUCTION_STYLE_VERSION } = require("./production-plan-compiler.cjs");

function buildProductionAnimationPayloadBindings({ project, approval, renderProfile, contentArtifacts }) {
  const active = project && project.input && project.input.activeNarration;
  if (!active || !active.alignmentArtifactId || !contentArtifacts) return {};
  const draft = normalizeDraftBundle(contentArtifacts.readJson(approval.draftArtifactId).body);
  if (draft.verticalId !== "dark_curiosity") return {};
  const alignment = normalizeAlignment(contentArtifacts.readJson(active.alignmentArtifactId).body);
  const timingContext = buildProductionTimingContext({ draft, alignment, projectId: project.id, projectRevision: project.input.revision, draftArtifactId: approval.draftArtifactId, draftHash: approval.draftHash, alignmentHash: active.alignmentHash });
  const animation = compileProductionAnimation({ draft, timingContext, projectId: project.id, projectRevision: project.input.revision, renderProfile });
  return Object.freeze({ timingContextHash: timingContext.contentHash, animationPlanHash: contentHash(animation.plan), animationIRHash: animation.animationIR.contentHash, animationProvider: PRODUCTION_PROVIDER_ID, animationRuntimeVersion: PRODUCTION_RUNTIME_VERSION, animationStyleVersion: PRODUCTION_STYLE_VERSION });
}

module.exports = { buildProductionAnimationPayloadBindings };
