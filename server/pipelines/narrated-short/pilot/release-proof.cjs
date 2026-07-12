function revokeFailedReleaseProof(created, publishApprovals, project) {
  if (!created || !created.approval || !project) return 0;
  return publishApprovals.revokeRevision(project.id, project.input.revision, "release_proof_failed");
}

module.exports = { revokeFailedReleaseProof };
