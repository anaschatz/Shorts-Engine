const {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
} = require("node:fs");
const { dirname } = require("node:path");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const {
  normalizeProject,
  projectSnapshotsEqual,
} = require("./project-repository.cjs");
const { nowIso, validateResourceId } = require("./ids.cjs");
const { storagePath, writeJsonAtomic, readJsonFile } = require("../storage.cjs");

const MAX_PROJECT_STATE_BYTES = 512 * 1024;
const PROJECT_STATE_FILE_RE = /^prj_[A-Za-z0-9-]{8,80}(?:\.render)?\.json$/;

function withProjectStateLock(projectId, callback) {
  const safeProjectId = validateResourceId(projectId, "prj");
  const lockPath = storagePath("projects", `${safeProjectId}.lock`);
  mkdirSync(dirname(lockPath), { recursive: true });
  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw new AppError(
        "PROJECT_STATE_LOCKED",
        SAFE_MESSAGES.PROJECT_STATE_LOCKED,
        409,
      );
    }
    throw error;
  }
  try {
    return callback();
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // The exclusive lock file still prevents an unsafe concurrent writer.
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // Fail closed on a future write if lock cleanup was interrupted.
    }
  }
}

function persistProjectUploadRecord({ project, upload }) {
  if (!project || !project.id || !upload || !upload.id) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return withProjectStateLock(project.id, () => {
    writeJsonAtomic(storagePath("projects", `${project.id}.json`), { project, upload });
    return project;
  });
}

function persistProjectRecord({ project } = {}) {
  if (!project || !project.id || project.projectType !== "narrated_short") {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return withProjectStateLock(project.id, () => {
    writeJsonAtomic(storagePath("projects", `${project.id}.json`), { project });
    return project;
  });
}

function readPersistedProjectRecord(projectId) {
  const safeProjectId = validateResourceId(projectId, "prj");
  const filePath = storagePath("projects", `${safeProjectId}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const envelope = readJsonFile(filePath);
    return envelope && envelope.project
      ? normalizeProject(envelope.project)
      : null;
  } catch {
    return null;
  }
}

function compareAndSwapProjectRecord({
  projectId,
  expectedProject,
  patch = {},
} = {}) {
  const safeProjectId = validateResourceId(projectId, "prj");
  if (!expectedProject || expectedProject.id !== safeProjectId) {
    throw new AppError(
      "VALIDATION_ERROR",
      SAFE_MESSAGES.VALIDATION_ERROR,
      400,
      { field: "expectedProject" },
    );
  }
  try {
    return withProjectStateLock(safeProjectId, () => {
      const filePath = storagePath("projects", `${safeProjectId}.json`);
      if (!existsSync(filePath)) {
        return { matched: false, project: null, busy: false };
      }
      let envelope;
      try {
        envelope = readJsonFile(filePath);
      } catch {
        return { matched: false, project: null, busy: false };
      }
      if (!envelope || !envelope.project) {
        return { matched: false, project: null, busy: false };
      }
      let current;
      try {
        current = normalizeProject(envelope.project);
      } catch {
        return { matched: false, project: null, busy: false };
      }
      if (!projectSnapshotsEqual(current, expectedProject)) {
        return { matched: false, project: current, busy: false };
      }
      const next = normalizeProject({
        ...current,
        ...patch,
        id: current.id,
        updatedAt: nowIso(),
      });
      writeJsonAtomic(filePath, { ...envelope, project: next });
      return { matched: true, project: next, busy: false };
    });
  } catch (error) {
    if (error && error.code === "PROJECT_STATE_LOCKED") {
      return { matched: false, project: null, busy: true };
    }
    throw error;
  }
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
    if (!project || !project.id) {
      ignored += 1;
      continue;
    }
    if (project.projectType === "narrated_short") {
      try {
        projectRepository.save(project);
        records += 1;
      } catch {
        ignored += 1;
      }
      continue;
    }
    if (!upload || !upload.id) {
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
  compareAndSwapProjectRecord,
  loadPersistedProjectState,
  persistProjectRecord,
  persistProjectUploadRecord,
  persistRenderRecord,
  readPersistedProjectRecord,
  withProjectStateLock,
};
