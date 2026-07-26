const { InMemoryExportRepository } = require("../repositories/export-repository.cjs");
const { InMemoryArtifactRepository } = require("../repositories/artifact-repository.cjs");
const { ApprovalOutboxRepository } = require("../repositories/approval-outbox-repository.cjs");
const {
  InMemoryProjectRepository,
  normalizeProject,
} = require("../repositories/project-repository.cjs");
const { RegenerationApprovalRepository } = require("../repositories/regeneration-approval-repository.cjs");
const { RegenerationDraftRepository } = require("../repositories/regeneration-draft-repository.cjs");
const { CONFIG, validatePersistenceAdapterMode } = require("../config.cjs");
const {
  compareAndSwapProjectRecord,
  loadPersistedProjectState,
  persistProjectRecord,
  persistProjectUploadRecord,
  persistRenderRecord,
  readPersistedProjectRecord,
} = require("../repositories/project-state.cjs");
const { InMemoryUploadRepository } = require("../repositories/upload-repository.cjs");
const { sanitizeText, validateResourceId } = require("../repositories/ids.cjs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { validateArtifactAdapter } = require("./artifact-adapter.cjs");
const { LocalArtifactAdapter } = require("./local-artifact-adapter.cjs");
const { createArtifactAdapterFromConfig } = require("./object-storage-adapter.cjs");
const { persistenceAdapterCapabilities, validatePersistenceAdapter } = require("./persistence-adapter.cjs");

function validateWorkerId(workerId) {
  const safe = sanitizeText(workerId, 100);
  if (!/^wrk_[A-Za-z0-9-]{8,80}$/.test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function validateLeaseId(leaseId) {
  const safe = sanitizeText(leaseId, 100);
  if (!/^lease_[A-Za-z0-9-]{8,80}$/.test(safe)) {
    throw new AppError("RESOURCE_ID_INVALID", SAFE_MESSAGES.RESOURCE_ID_INVALID, 400);
  }
  return safe;
}

function validateLeaseDurationMs(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 1000 || duration > 60 * 60 * 1000) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return Math.floor(duration);
}

function cloneRecord(record) {
  return record ? JSON.parse(JSON.stringify(record)) : null;
}

function isLeaseExpired(record, nowMs) {
  const expiresMs = Date.parse(record && record.leaseExpiresAt ? record.leaseExpiresAt : "");
  if (Number.isFinite(expiresMs)) return expiresMs <= nowMs;
  return record && record.status === "processing";
}

function retryIsDue(record, nowMs) {
  const retryAtMs = Date.parse(record && record.nextRetryAt ? record.nextRetryAt : "");
  return !Number.isFinite(retryAtMs) || retryAtMs <= nowMs;
}

class LocalPersistenceAdapter {
  constructor(options = {}) {
    this.artifactAdapter = validateArtifactAdapter(options.artifactAdapter || new LocalArtifactAdapter());
    this.artifactStore = this.artifactAdapter;
    this.projectRepository = options.projectRepository || new InMemoryProjectRepository();
    this.uploadRepository = options.uploadRepository || new InMemoryUploadRepository({ artifactStore: this.artifactAdapter });
    this.artifactRepository = options.artifactRepository || new InMemoryArtifactRepository({
      persist: options.persistArtifacts !== false,
      storageAdapterMode: this.artifactAdapter.mode || "local",
    });
    this.exportRepository = options.exportRepository || new InMemoryExportRepository({ artifactStore: this.artifactAdapter });
    this.regenerationDraftRepository = options.regenerationDraftRepository || new RegenerationDraftRepository();
    this.regenerationApprovalRepository = options.regenerationApprovalRepository || new RegenerationApprovalRepository();
    this.approvalOutboxRepository = options.approvalOutboxRepository || new ApprovalOutboxRepository();
    this.projects = this.projectRepository.records;
    this.uploads = this.uploadRepository.records;
    this.artifacts = this.artifactRepository.records;
    this.exportsById = this.exportRepository.records;
    this.idempotency = options.idempotency || new Map();
    this.persistedJobs = options.persistedJobs || new Map();
    validatePersistenceAdapter(this);
  }

  createProject(record) {
    return this.projectRepository.create(record);
  }

  getProject(projectId) {
    return this.projectRepository.get(projectId);
  }

  updateProject(projectId, patch) {
    return this.projectRepository.update(projectId, patch);
  }

  compareAndSwapProject({ projectId, expectedProject, patch = {} } = {}) {
    const result = compareAndSwapProjectRecord({
      projectId,
      expectedProject,
      patch,
    });
    if (result.busy) {
      throw new AppError(
        "PROJECT_STATE_LOCKED",
        SAFE_MESSAGES.PROJECT_STATE_LOCKED,
        409,
        { retryable: true },
      );
    }
    if (result.project) {
      const refreshed = this.projectRepository.save(result.project);
      return result.matched ? refreshed : null;
    }
    this.projectRepository.delete(projectId);
    return null;
  }

  publicProject(project) {
    return this.projectRepository.publicProject(project);
  }

  persistProject({ project } = {}) {
    const projectRecord = normalizeProject(project);
    try {
      persistProjectRecord({ project: projectRecord });
    } catch (error) {
      const durableProject = readPersistedProjectRecord(projectRecord.id);
      if (durableProject) this.projectRepository.save(durableProject);
      else this.projectRepository.delete(projectRecord.id);
      throw error;
    }
    return this.projectRepository.save(projectRecord);
  }

  createUpload(record) {
    const upload = this.uploadRepository.create(record);
    this.createArtifact(upload.artifact);
    return upload;
  }

  getUpload(uploadId) {
    return this.uploadRepository.get(uploadId);
  }

  publicUpload(upload) {
    return this.uploadRepository.publicUpload(upload);
  }

  createArtifact(record) {
    return this.artifactRepository.create({
      ...record,
      storageAdapterMode: record && record.storageAdapterMode ? record.storageAdapterMode : this.artifactAdapter.mode || "local",
    });
  }

  getArtifact(artifactId) {
    return this.artifactRepository.get(artifactId);
  }

  updateArtifact(artifactId, patch) {
    return this.artifactRepository.update(artifactId, patch);
  }

  publicArtifact(artifact) {
    return this.artifactRepository.publicArtifact(artifact);
  }

  listArtifactsForOwner(options) {
    return this.artifactRepository.listByOwner(options);
  }

  listCleanupArtifactCandidates(options) {
    return this.artifactRepository.listCleanupCandidates(options);
  }

  markArtifactDeleted(artifactId) {
    return this.artifactRepository.markDeleted(artifactId);
  }

  markArtifactMissing(artifactId) {
    return this.artifactRepository.markMissing(artifactId);
  }

  createExport(record) {
    const exportRecord = this.exportRepository.create(record);
    this.createArtifact(exportRecord.artifact);
    return exportRecord;
  }

  getExport(exportId) {
    return this.exportRepository.get(exportId);
  }

  publicExport(exportRecord) {
    return this.exportRepository.publicExport(exportRecord);
  }

  getExportDownloadDescriptor(exportRecord, options) {
    return this.exportRepository.getDownloadDescriptor(exportRecord, options);
  }

  createSignedExportDownload(exportRecord, options) {
    return this.exportRepository.createSignedDownload(exportRecord, options);
  }

  resolveExportOutputPath(exportRecord) {
    return this.exportRepository.resolveOutputPath(exportRecord);
  }

  transaction(callback) {
    return callback(this);
  }

  createProjectUpload({ project, upload } = {}) {
    return this.transaction(() => {
      const uploadRecord = this.createUpload(upload);
      const projectRecord = this.createProject(project);
      this.persistProjectUpload({ project: projectRecord, upload: uploadRecord });
      return { project: projectRecord, upload: uploadRecord };
    });
  }

  persistProjectUpload(record) {
    return persistProjectUploadRecord(record);
  }

  persistJob(job) {
    if (!job || typeof job !== "object") return null;
    const jobId = validateResourceId(job.id, "job");
    const record = JSON.parse(JSON.stringify(job));
    delete record._controller;
    this.persistedJobs.set(jobId, record);
    if (record.idempotencyKey) {
      this.persistIdempotencyKey(record.idempotencyKey, jobId, record.action || "generate");
    }
    return record;
  }

  getPersistedJob(jobId) {
    const record = this.persistedJobs.get(validateResourceId(jobId, "job")) || null;
    return cloneRecord(record);
  }

  listPersistedJobs() {
    return [...this.persistedJobs.values()].map((record) => cloneRecord(record));
  }

  claimPersistedJob(options = {}) {
    const workerId = validateWorkerId(options.workerId);
    const leaseId = validateLeaseId(options.leaseId);
    const leaseMs = validateLeaseDurationMs(options.leaseMs);
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const maxAttempts = Math.max(1, Math.floor(Number(options.maxAttempts || 1)));
    const requestedJobId = options.jobId ? validateResourceId(options.jobId, "job") : null;
    const records = [...this.persistedJobs.values()]
      .filter((record) => !requestedJobId || record.id === requestedJobId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    for (const record of records) {
      if (!record || !["queued", "processing"].includes(record.status)) continue;
      if (record.status === "queued" && !retryIsDue(record, nowMs)) continue;
      if (record.status === "processing" && !isLeaseExpired(record, nowMs)) continue;
      if (record.status === "processing" && Number(record.attempts || 0) >= maxAttempts) {
        this.persistJob({
          ...record,
          status: "failed",
          step: "failed",
          error: { code: "JOB_STALE", message: SAFE_MESSAGES.JOB_STALE },
          workerId: null,
          leaseId: null,
          claimedAt: null,
          leaseExpiresAt: null,
          updatedAt: new Date(nowMs).toISOString(),
        });
        continue;
      }
      const claimedAt = new Date(nowMs).toISOString();
      return this.persistJob({
        ...record,
        status: "processing",
        progress: Math.max(1, Math.min(100, Math.round(Number(record.progress || 0)))),
        step: record.step && record.step !== "queued" ? record.step : "queued",
        error: null,
        attempts: Number(record.attempts || 0) + 1,
        workerId,
        leaseId,
        claimedAt,
        leaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
        lastHeartbeatAt: claimedAt,
        nextRetryAt: null,
        backoffMs: null,
        updatedAt: claimedAt,
      });
    }
    return null;
  }

  persistClaimedJob(job, lease = {}) {
    const record = cloneRecord(job);
    const jobId = validateResourceId(record && record.id, "job");
    const current = this.persistedJobs.get(jobId);
    if (
      !current ||
      current.status !== "processing" ||
      current.workerId !== validateWorkerId(lease.workerId) ||
      current.leaseId !== validateLeaseId(lease.leaseId) ||
      isLeaseExpired(current, Number.isFinite(Number(lease.nowMs)) ? Number(lease.nowMs) : Date.now())
    ) {
      throw new AppError("JOB_LEASE_INVALID", SAFE_MESSAGES.JOB_LEASE_INVALID, 409);
    }
    return this.persistJob(record);
  }

  persistIdempotencyKey(key, jobId, action = "generate") {
    const safeKey = sanitizeText(key, 160);
    if (!/^[A-Za-z0-9_-]{8,160}$/.test(safeKey)) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
    }
    const safeJobId = validateResourceId(jobId, "job");
    this.idempotency.set(safeKey, {
      key: safeKey,
      jobId: safeJobId,
      action: sanitizeText(action || "generate", 60),
      createdAt: new Date().toISOString(),
    });
    return this.idempotency.get(safeKey);
  }

  getIdempotencyJobId(key) {
    const safeKey = sanitizeText(key, 160);
    const record = this.idempotency.get(safeKey);
    return record ? record.jobId : null;
  }

  persistRenderRecord(record) {
    return persistRenderRecord(record);
  }

  indexRepositoryArtifacts() {
    let records = 0;
    let ignored = 0;
    for (const upload of this.uploadRepository.all()) {
      try {
        if (upload.artifact) {
          this.createArtifact(upload.artifact);
          records += 1;
        }
      } catch {
        ignored += 1;
      }
    }
    for (const exportRecord of this.exportRepository.all()) {
      try {
        if (exportRecord.artifact) {
          this.createArtifact(exportRecord.artifact);
          records += 1;
        }
      } catch {
        ignored += 1;
      }
    }
    return { records, ignored };
  }

  restoreState() {
    const artifactIndex = this.artifactRepository.restore();
    const draftAudits = this.regenerationDraftRepository.restore();
    const approvalAudits = this.regenerationApprovalRepository.restore();
    const approvalOutbox = this.approvalOutboxRepository.restore();
    const projectState = loadPersistedProjectState({
      projectRepository: this.projectRepository,
      uploadRepository: this.uploadRepository,
      exportRepository: this.exportRepository,
      artifactStore: this.artifactAdapter,
    });
    const indexedArtifacts = this.indexRepositoryArtifacts();
    return {
      ...projectState,
      artifactIndex,
      indexedArtifacts,
      draftAudits,
      approvalAudits,
      approvalOutbox,
    };
  }

  getRegenerationDraftRepository() {
    return this.regenerationDraftRepository;
  }

  getRegenerationApprovalRepository() {
    return this.regenerationApprovalRepository;
  }

  getApprovalOutboxRepository() {
    return this.approvalOutboxRepository;
  }

  health() {
    const repositories = {
      projects: this.projectRepository.health(),
      uploads: this.uploadRepository.health(),
      artifacts: this.artifactRepository.health(),
      exports: this.exportRepository.health(),
      regenerationDrafts: this.regenerationDraftRepository.health(),
      regenerationApprovals: this.regenerationApprovalRepository.health(),
      approvalOutbox: this.approvalOutboxRepository.health(),
    };
    return {
      ready: Object.values(repositories).every((entry) => entry.ready),
      adapter: "local-persistence",
      mode: "local",
      database: false,
      transactions: false,
      durable: false,
      capabilities: persistenceAdapterCapabilities(this),
      repositories,
    };
  }
}

function createDefaultAdapters(options = {}) {
  const artifactAdapter = validateArtifactAdapter(options.artifactAdapter || createArtifactAdapterFromConfig(options));
  const mode = validatePersistenceAdapterMode(options.persistenceAdapterMode || options.persistenceMode || CONFIG.persistence.adapter);
  let persistenceAdapter = options.persistenceAdapter;
  if (!persistenceAdapter && mode === "sqlite") {
    const { SQLitePersistenceAdapter } = require("./sqlite-persistence-adapter.cjs");
    persistenceAdapter = new SQLitePersistenceAdapter({ ...options, artifactAdapter });
  }
  if (!persistenceAdapter) {
    persistenceAdapter = new LocalPersistenceAdapter({ ...options, artifactAdapter });
  }
  persistenceAdapter = validatePersistenceAdapter(persistenceAdapter);
  return { artifactAdapter, persistenceAdapter };
}

module.exports = {
  LocalPersistenceAdapter,
  createDefaultAdapters,
};
