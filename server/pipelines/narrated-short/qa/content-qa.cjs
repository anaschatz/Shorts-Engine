const { gate } = require("./contract.cjs");

function runContentQa({ project, approval, draftEnvelope, draft }) {
  const claimIds = new Set(draft.claimLedger.claims.map((claim) => claim.id));
  const sourceIds = new Set(draft.claimLedger.sources.map((source) => source.id));
  const sceneRefs = draft.storyboard.scenes.flatMap((scene) => scene.operations.flatMap((operation) => [operation.claimId, operation.sourceId].filter(Boolean)));
  return [
    gate("CONTENT_APPROVAL_EXACT", "content", Boolean(approval && approval.projectRevision === project.input.revision && approval.draftArtifactId === draftEnvelope.artifactId && approval.draftHash === draftEnvelope.contentHash), { expected: project.input.revision, actual: approval && approval.projectRevision || 0 }),
    gate("CONTENT_DRAFT_HASH_VALID", "content", draft.contentHash === draftEnvelope.contentHash, { expected: draftEnvelope.contentHash, actual: draft.contentHash }),
    gate("CONTENT_SCRIPT_HASH_VALID", "content", draft.script.contentHash === project.input.activeNarration.scriptHash, { expected: project.input.activeNarration.scriptHash, actual: draft.script.contentHash }),
    gate("CONTENT_STORYBOARD_VALID", "content", draft.storyboard.scenes.length >= 1, { count: draft.storyboard.scenes.length }),
    gate("CONTENT_CLAIMS_BOUND", "content", sceneRefs.every((ref) => claimIds.has(ref) || sourceIds.has(ref)), { count: sceneRefs.length }),
    gate("CONTENT_RISK_ALLOWED", "content", draft.brief.riskClass === "ordinary", { actual: draft.brief.riskClass, expected: "ordinary" }),
  ];
}
module.exports = { runContentQa };
