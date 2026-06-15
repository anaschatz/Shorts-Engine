const { existsSync, readdirSync, statSync } = require("node:fs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { storagePath, writeJsonAtomic, readJsonFile } = require("../storage.cjs");

const MAX_PROJECT_STATE_BYTES = 512 * 1024;
const PROJECT_STATE_FILE_RE = /^prj_[A-Za-z0-9-]{8,80}(?:\.render)?\.json$/;

function persistProjectUploadRecord({ project, upload }) {
  if (!project || !project.id || !upload || !upload.id) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  writeJsonAtomic(storagePath("projects", `${project.id}.json`), { project, upload });
}

function persistRenderRecord(record = {}) {
  const { project } = record;
  if (!project || !project.id) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  writeJsonAtomic(storagePath("projects", `${project.id}.render.json`), record);
}

function loadPersistedProjectState({
  projectRepository,
  uploadRepository,
  exportRepository,
  artifactStore,
} = {}) {
  let records = 0;
  let ignored = 0;
  for (const fileName of readdirSync(storagePath("projects", "."))) {
    if (!fileName.endsWith(".json")) continue;
    if (!PROJECT_STATE_FILE_RE.test(fileName)) {
      ignored += 1;
      continue;
    }
    let stat;
    try {
      stat = statSync(storagePath("projects", fileName));
    } catch {
      ignored += 1;
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_PROJECT_STATE_BYTES) {
      ignored += 1;
      continue;
    }
    let record;
    try {
      record = readJsonFile(storagePath("projects", fileName));
    } catch {
      ignored += 1;
      continue;
    }

    if (fileName.endsWith(".render.json")) {
      const { project, job, exportId, exportRecord } = record || {};
      if (!project || !job || !exportId) {
        ignored += 1;
        continue;
      }
      try {
        const artifact = exportRecord && exportRecord.artifact
          ? exportRecord.artifact
          : artifactStore.createRecord({
              id: exportId,
              type: "export",
              ownerProjectId: project.id,
              ownerJobId: job.id,
              storageKey: `${job.id}.mp4`,
              status: "available",
              createdAt: job.updatedAt,
            });
        const restored = exportRepository.restore({
          id: exportId,
          projectId: project.id,
          jobId: job.id,
          outputPath: job.outputPath || null,
          artifact,
          fileName: `${project.id}-short.mp4`,
          createdAt: job.updatedAt,
        });
        if (restored) records += 1;
      } catch {
        ignored += 1;
      }
      continue;
    }

    const { project, upload } = record || {};
    if (!project || !upload || !project.id || !upload.id) {
      ignored += 1;
      continue;
    }
    try {
      const artifact = upload.artifact || artifactStore.createRecord({
        id: upload.id,
        type: "upload",
        ownerProjectId: project.id,
        storageKey: upload.storageKey || `${upload.id}.${upload.extension || "mp4"}`,
        size: upload.byteSize,
        status: "available",
        createdAt: upload.createdAt,
      });
      let uploadPath = null;
      if (upload.path) {
        uploadPath = artifactStore.assertPathForType("upload", upload.path);
      } else {
        try {
          uploadPath = artifactStore.resolveLocalPath ? artifactStore.resolveLocalPath(artifact) : artifactStore.resolve(artifact);
        } catch {
          uploadPath = null;
        }
      }
      const artifactExists = uploadPath
        ? existsSync(uploadPath) && statSync(uploadPath).isFile()
        : artifactStore.artifactExists && artifactStore.artifactExists(artifact);
      if (!artifactExists) {
        ignored += 1;
        continue;
      }
      const savedProject = projectRepository.save(project);
      uploadRepository.save({ ...upload, projectId: savedProject.id, artifact, path: uploadPath });
      records += 1;
    } catch {
      ignored += 1;
    }
  }
  return { records, ignored };
}

module.exports = {
  loadPersistedProjectState,
  persistProjectUploadRecord,
  persistRenderRecord,
};
