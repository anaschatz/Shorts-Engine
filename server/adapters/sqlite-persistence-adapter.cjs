const { mkdirSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { normalizeOwnerId } = require("../auth.cjs");
const { CONFIG } = require("../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { ApprovalOutboxRepository, normalizeOutboxEvent } = require("../repositories/approval-outbox-repository.cjs");
const { InMemoryExportRepository, normalizeExport } = require("../repositories/export-repository.cjs");
const { normalizeArtifactRecord, publicArtifactRecord, ARTIFACT_INDEX_STATUSES } = require("../repositories/artifact-repository.cjs");
const { PROJECT_STATUSES, normalizeProject } = require("../repositories/project-repository.cjs");
const { RegenerationApprovalRepository, normalizeApprovalRecord } = require("../repositories/regeneration-approval-repository.cjs");
const { RegenerationDraftRepository, normalizeDraftRecord } = require("../repositories/regeneration-draft-repository.cjs");
const { normalizeUpload } = require("../repositories/upload-repository.cjs");
const { jsonClone, nowIso, sanitizeText, validateResourceId } = require("../repositories/ids.cjs");
const { assertStoragePath } = require("../storage.cjs");
const { validateArtifactAdapter } = require("./artifact-adapter.cjs");
const { LocalArtifactAdapter } = require("./local-artifact-adapter.cjs");
const { persistenceAdapterCapabilities, validatePersistenceAdapter } = require("./persistence-adapter.cjs");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const SQLITE_AVAILABLE = Boolean(DatabaseSync);

const LATEST_SCHEMA_VERSION = 7;
const MIGRATIONS = Object.freeze([
  {
    version: 1,
    name: "initial_repository_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        appliedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        uploadId TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        artifactJson TEXT NOT NULL,
        storageKey TEXT NOT NULL,
        path TEXT,
        originalFilename TEXT NOT NULL,
        mimeType TEXT NOT NULL,
        extension TEXT NOT NULL,
        container TEXT NOT NULL,
        byteSize INTEGER NOT NULL,
        checksumSha256 TEXT NOT NULL,
        metadataJson TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        ownerProjectId TEXT,
        ownerJobId TEXT,
        size INTEGER,
        contentType TEXT NOT NULL,
        checksumSha256 TEXT NOT NULL,
        storageAdapterMode TEXT NOT NULL,
        storageKey TEXT,
        path TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        recordJson TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exports (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        jobId TEXT NOT NULL,
        artifactJson TEXT NOT NULL,
        storageKey TEXT NOT NULL,
        outputPath TEXT,
        fileName TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        uploadId TEXT,
        action TEXT NOT NULL,
        idempotencyKey TEXT,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL,
        step TEXT,
        errorJson TEXT,
        outputPath TEXT,
        exportId TEXT,
        payloadJson TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        recordJson TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        jobId TEXT NOT NULL,
        action TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS render_records (
        projectId TEXT PRIMARY KEY,
        exportId TEXT,
        jobId TEXT,
        recordJson TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "smoke_source_markers",
    sql: `
      ALTER TABLE projects ADD COLUMN source TEXT;
      ALTER TABLE uploads ADD COLUMN source TEXT;
      ALTER TABLE exports ADD COLUMN source TEXT;
    `,
  },
  {
    version: 3,
    name: "approval_audit_and_outbox",
    sql: `
      CREATE TABLE IF NOT EXISTS regeneration_drafts (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        sourceJobId TEXT NOT NULL,
        sourceExportId TEXT NOT NULL,
        regenerationPlanId TEXT NOT NULL,
        draftHash TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        validationStatus TEXT NOT NULL,
        proposedEditPlanSummaryJson TEXT,
        appliedSuggestionIdsJson TEXT NOT NULL,
        skippedSuggestionIdsJson TEXT NOT NULL,
        proposedChangesJson TEXT NOT NULL,
        blockingReasonCodesJson TEXT NOT NULL,
        safetyChecksJson TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        recordJson TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_regeneration_drafts_source
        ON regeneration_drafts (projectId, sourceJobId, sourceExportId);
      CREATE INDEX IF NOT EXISTS idx_regeneration_drafts_plan_hash
        ON regeneration_drafts (regenerationPlanId, draftHash);

      CREATE TABLE IF NOT EXISTS regeneration_approvals (
        approvalId TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        sourceJobId TEXT NOT NULL,
        sourceExportId TEXT NOT NULL,
        regenerationPlanId TEXT NOT NULL,
        draftHash TEXT NOT NULL,
        idempotencyKey TEXT NOT NULL UNIQUE,
        draftRecordId TEXT,
        newRenderJobId TEXT,
        completedExportId TEXT,
        approvedAt TEXT NOT NULL,
        approvedBy TEXT NOT NULL,
        status TEXT NOT NULL,
        errorCode TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        recordJson TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_regeneration_approvals_source
        ON regeneration_approvals (projectId, sourceJobId, sourceExportId);
      CREATE INDEX IF NOT EXISTS idx_regeneration_approvals_render_job
        ON regeneration_approvals (newRenderJobId);
      CREATE INDEX IF NOT EXISTS idx_regeneration_approvals_status
        ON regeneration_approvals (status);

      CREATE TABLE IF NOT EXISTS approval_outbox (
        id TEXT PRIMARY KEY,
        eventType TEXT NOT NULL,
        approvalId TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        nextAttemptAt TEXT,
        lastErrorCode TEXT,
        payloadJson TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        recordJson TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approval_outbox_status
        ON approval_outbox (status, createdAt);
      CREATE INDEX IF NOT EXISTS idx_approval_outbox_approval
        ON approval_outbox (approvalId, eventType);
    `,
  },
  {
    version: 4,
    name: "approval_outbox_delivery_lifecycle",
    sql: `
      ALTER TABLE approval_outbox ADD COLUMN maxAttempts INTEGER;
      ALTER TABLE approval_outbox ADD COLUMN lockedAt TEXT;
      ALTER TABLE approval_outbox ADD COLUMN lockOwner TEXT;
      ALTER TABLE approval_outbox ADD COLUMN deliveredAt TEXT;
      CREATE INDEX IF NOT EXISTS idx_approval_outbox_delivery
        ON approval_outbox (status, nextAttemptAt, createdAt);
      CREATE INDEX IF NOT EXISTS idx_approval_outbox_lock
        ON approval_outbox (status, lockedAt, lockOwner);
    `,
  },
  {
    version: 5,
    name: "auth_owner_boundary",
    sql: `
      ALTER TABLE projects ADD COLUMN ownerId TEXT;
      ALTER TABLE uploads ADD COLUMN ownerId TEXT;
      ALTER TABLE exports ADD COLUMN ownerId TEXT;
      ALTER TABLE jobs ADD COLUMN ownerId TEXT;
      CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (ownerId);
      CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs (ownerId);
      CREATE INDEX IF NOT EXISTS idx_exports_owner ON exports (ownerId);
    `,
  },
  {
    version: 6,
    name: "narrated_project_v2",
    sql: `
      CREATE TABLE projects_v2 (
        id TEXT PRIMARY KEY,
        uploadId TEXT,
        schemaVersion INTEGER NOT NULL DEFAULT 2,
        projectType TEXT NOT NULL DEFAULT 'clip',
        inputJson TEXT,
        language TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        ownerId TEXT,
        source TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      INSERT INTO projects_v2 (
        id, uploadId, schemaVersion, projectType, inputJson, language,
        title, status, ownerId, source, createdAt, updatedAt
      )
      SELECT id, uploadId, 2, 'clip', NULL, NULL,
        title, status, ownerId, source, createdAt, updatedAt
      FROM projects;
      DROP TABLE projects;
      ALTER TABLE projects_v2 RENAME TO projects;
      CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (ownerId);
      CREATE INDEX IF NOT EXISTS idx_projects_type ON projects (projectType);
    `,
  },
  {
    version: 7,
    name: "football_candidate_review",
    sql: `
      CREATE TABLE IF NOT EXISTS football_reviews (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        ownerId TEXT NOT NULL,
        sourceJobId TEXT NOT NULL,
        sourceUploadId TEXT NOT NULL,
        sourceRevision TEXT NOT NULL,
        projectRevision INTEGER NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        selectedCandidateId TEXT,
        reviewerId TEXT,
        reviewedAt TEXT,
        renderJobId TEXT,
        regenerationJobId TEXT,
        decisionIdempotencyKey TEXT UNIQUE,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        recordJson TEXT NOT NULL,
        UNIQUE(projectId, sourceJobId, sourceRevision)
      );
      CREATE TABLE IF NOT EXISTS football_review_candidates (
        id TEXT PRIMARY KEY,
        reviewId TEXT NOT NULL,
        sourceStart REAL NOT NULL,
        sourceEnd REAL NOT NULL,
        confidence REAL NOT NULL,
        reasonCodesJson TEXT NOT NULL,
        evidenceJson TEXT NOT NULL,
        framingJson TEXT NOT NULL,
        editPlanJson TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        FOREIGN KEY(reviewId) REFERENCES football_reviews(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS football_review_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reviewId TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        eventType TEXT NOT NULL,
        actorId TEXT,
        fromStatus TEXT,
        toStatus TEXT NOT NULL,
        version INTEGER NOT NULL,
        candidateId TEXT,
        renderJobId TEXT,
        reasonCode TEXT,
        createdAt TEXT NOT NULL,
        UNIQUE(reviewId, sequence),
        FOREIGN KEY(reviewId) REFERENCES football_reviews(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_football_reviews_owner
        ON football_reviews (ownerId, updatedAt);
      CREATE INDEX IF NOT EXISTS idx_football_reviews_source
        ON football_reviews (projectId, sourceJobId, sourceRevision);
      CREATE INDEX IF NOT EXISTS idx_football_reviews_status
        ON football_reviews (status, updatedAt);
      CREATE INDEX IF NOT EXISTS idx_football_review_candidates_review
        ON football_review_candidates (reviewId);
      CREATE INDEX IF NOT EXISTS idx_football_review_audit_review
        ON football_review_audit (reviewId, sequence);
    `,
  },
]);

const HEALTH_TABLES = Object.freeze(new Set([
  "projects",
  "uploads",
  "artifacts",
  "exports",
  "jobs",
  "idempotency_keys",
  "regeneration_drafts",
  "regeneration_approvals",
  "approval_outbox",
  "football_reviews",
  "football_review_candidates",
  "football_review_audit",
]));

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringifyRecord(value) {
  return JSON.stringify(jsonClone(value));
}

function validateDatabasePath(filePath) {
  const resolved = resolve(String(filePath || CONFIG.persistence.filePath));
  return assertStoragePath(resolved, "db");
}

function validateIdempotencyKey(key) {
  const safeKey = sanitizeText(key, 160);
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(safeKey)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return safeKey;
}

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

function leaseExpired(record, nowMs) {
  const expiresMs = Date.parse(record && record.leaseExpiresAt ? record.leaseExpiresAt : "");
  if (Number.isFinite(expiresMs)) return expiresMs <= nowMs;
  return record && record.status === "processing";
}

function retryDue(record, nowMs) {
  const retryAtMs = Date.parse(record && record.nextRetryAt ? record.nextRetryAt : "");
  return !Number.isFinite(retryAtMs) || retryAtMs <= nowMs;
}

function rowCount(db, tableName) {
  if (!HEALTH_TABLES.has(tableName)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  return Number(db.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get().total || 0);
}

function sameApprovalRequest(a = {}, b = {}) {
  return (
    a.projectId === b.projectId &&
    a.sourceJobId === b.sourceJobId &&
    a.sourceExportId === b.sourceExportId &&
    a.regenerationPlanId === b.regenerationPlanId &&
    a.draftHash === b.draftHash
  );
}

class SQLitePersistenceAdapter {
  constructor(options = {}) {
    this.mode = "sqlite";
    if (!options.database && !DatabaseSync) {
      throw new AppError("DB_MIGRATION_FAILED", SAFE_MESSAGES.DB_MIGRATION_FAILED, 500);
    }
    this.databasePath = validateDatabasePath(options.databasePath || CONFIG.persistence.filePath);
    mkdirSync(dirname(this.databasePath), { recursive: true });
    this.db = options.database || new DatabaseSync(this.databasePath);
    this.artifactAdapter = validateArtifactAdapter(options.artifactAdapter || new LocalArtifactAdapter());
    this.artifactStore = this.artifactAdapter;
    this.storageAdapterMode = this.artifactAdapter.mode || "local";
    this.projectRows = new Map();
    this.uploadRows = new Map();
    this.artifactRows = new Map();
    this.exportRows = new Map();
    this.regenerationDraftRows = new Map();
    this.regenerationApprovalRows = new Map();
    this.approvalOutboxRows = new Map();
    this.exportView = new InMemoryExportRepository({ artifactStore: this.artifactAdapter });
    this.regenerationDraftView = new RegenerationDraftRepository({ records: this.regenerationDraftRows, persist: false });
    this.regenerationApprovalView = new RegenerationApprovalRepository({ records: this.regenerationApprovalRows, persist: false });
    this.approvalOutboxView = new ApprovalOutboxRepository({ records: this.approvalOutboxRows, persist: false });
    this.transactionDepth = 0;
    this.migrationVersion = 0;
    this.projectRepository = this.createProjectRepositoryFacade();
    this.uploadRepository = this.createUploadRepositoryFacade();
    this.artifactRepository = this.createArtifactRepositoryFacade();
    this.exportRepository = this.createExportRepositoryFacade();
    this.regenerationDraftRepository = this.createRegenerationDraftRepositoryFacade();
    this.regenerationApprovalRepository = this.createRegenerationApprovalRepositoryFacade();
    this.approvalOutboxRepository = this.createApprovalOutboxRepositoryFacade();
    this.projects = this.projectRows;
    this.uploads = this.uploadRows;
    this.artifacts = this.artifactRows;
    this.exportsById = this.exportRows;
    this.migrate();
    validatePersistenceAdapter(this);
  }

  exec(sql) {
    this.db.exec(sql);
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  migrate() {
    try {
      this.exec("PRAGMA foreign_keys = ON;");
      this.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, appliedAt TEXT NOT NULL);");
      for (const migration of MIGRATIONS) {
        const existing = this.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(migration.version);
        if (existing) continue;
        this.transaction(() => {
          this.exec(migration.sql);
          this.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, appliedAt) VALUES (?, ?, ?)").run(
            migration.version,
            migration.name,
            nowIso(),
          );
        });
      }
      const current = this.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
      this.migrationVersion = Number(current && current.version ? current.version : 0);
      return this.migrationVersion;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("DB_MIGRATION_FAILED", SAFE_MESSAGES.DB_MIGRATION_FAILED, 500);
    }
  }

  transaction(callback) {
    if (typeof callback !== "function") {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
    }
    if (this.transactionDepth > 0) return callback(this);
    const snapshot = {
      projects: new Map(this.projectRows),
      uploads: new Map(this.uploadRows),
      artifacts: new Map(this.artifactRows),
      exports: new Map(this.exportRows),
      exportView: new Map(this.exportView.records),
      regenerationDrafts: new Map(this.regenerationDraftRows),
      regenerationApprovals: new Map(this.regenerationApprovalRows),
      approvalOutbox: new Map(this.approvalOutboxRows),
    };
    this.exec("BEGIN IMMEDIATE;");
    this.transactionDepth += 1;
    try {
      const result = callback(this);
      this.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.exec("ROLLBACK;");
      } catch {
        // Keep the original error; rollback failure is not useful to public callers.
      }
      this.projectRows.clear();
      this.uploadRows.clear();
      this.artifactRows.clear();
      this.exportRows.clear();
      this.exportView.records.clear();
      this.regenerationDraftRows.clear();
      this.regenerationApprovalRows.clear();
      this.approvalOutboxRows.clear();
      for (const [key, value] of snapshot.projects) this.projectRows.set(key, value);
      for (const [key, value] of snapshot.uploads) this.uploadRows.set(key, value);
      for (const [key, value] of snapshot.artifacts) this.artifactRows.set(key, value);
      for (const [key, value] of snapshot.exports) this.exportRows.set(key, value);
      for (const [key, value] of snapshot.exportView) this.exportView.records.set(key, value);
      for (const [key, value] of snapshot.regenerationDrafts) this.regenerationDraftRows.set(key, value);
      for (const [key, value] of snapshot.regenerationApprovals) this.regenerationApprovalRows.set(key, value);
      for (const [key, value] of snapshot.approvalOutbox) this.approvalOutboxRows.set(key, value);
      if (error instanceof AppError) throw error;
      throw new AppError("DB_TRANSACTION_FAILED", SAFE_MESSAGES.DB_TRANSACTION_FAILED, 500);
    } finally {
      this.transactionDepth -= 1;
    }
  }

  createProjectRepositoryFacade() {
    return {
      records: this.projectRows,
      create: (record) => this.createProject(record),
      save: (record) => this.createProject(record),
      get: (projectId) => this.getProject(projectId),
      update: (projectId, patch) => this.updateProject(projectId, patch),
      compareAndSwap: (projectId, expectedProject, patch) => this.compareAndSwapProject({
        projectId,
        expectedProject,
        patch,
      }),
      delete: (projectId) => this.deleteProject(projectId),
      all: () => [...this.projectRows.values()],
      publicProject: (project) => this.publicProject(project),
      health: () => this.projectHealth(),
    };
  }

  createUploadRepositoryFacade() {
    return {
      records: this.uploadRows,
      create: (record) => this.createUpload(record),
      save: (record) => this.createUpload(record),
      get: (uploadId) => this.getUpload(uploadId),
      getForProject: (projectId) => {
        const safeProjectId = validateResourceId(projectId, "prj");
        return this.allUploads().find((upload) => upload.projectId === safeProjectId) || null;
      },
      delete: (uploadId) => this.deleteUpload(uploadId),
      all: () => this.allUploads(),
      publicUpload: (upload) => this.publicUpload(upload),
      health: () => this.repositoryHealth("uploads"),
    };
  }

  createArtifactRepositoryFacade() {
    return {
      records: this.artifactRows,
      create: (record) => this.createArtifact(record),
      save: (record) => this.createArtifact(record),
      get: (artifactId) => this.getArtifact(artifactId),
      update: (artifactId, patch) => this.updateArtifact(artifactId, patch),
      markDeleted: (artifactId) => this.markArtifactDeleted(artifactId),
      markMissing: (artifactId) => this.markArtifactMissing(artifactId),
      listByOwner: (options) => this.listArtifactsForOwner(options),
      listCleanupCandidates: (options) => this.listCleanupArtifactCandidates(options),
      all: () => this.allArtifacts(),
      publicArtifact: (artifact) => this.publicArtifact(artifact),
      health: () => this.artifactHealth(),
    };
  }

  createExportRepositoryFacade() {
    return {
      records: this.exportRows,
      create: (record) => this.createExport(record),
      restore: (record) => {
        try {
          return this.createExport(record);
        } catch {
          return null;
        }
      },
      get: (exportId) => this.getExport(exportId),
      delete: (exportId) => this.deleteExport(exportId),
      all: () => this.allExports(),
      publicExport: (exportRecord) => this.publicExport(exportRecord),
      getDownloadDescriptor: (exportRecord, options) => this.getExportDownloadDescriptor(exportRecord, options),
      createSignedDownload: (exportRecord, options) => this.createSignedExportDownload(exportRecord, options),
      resolveOutputPath: (exportRecord) => this.resolveExportOutputPath(exportRecord),
      health: () => this.repositoryHealth("exports", { completed: rowCount(this.db, "exports") }),
    };
  }

  createRegenerationDraftRepositoryFacade() {
    return {
      records: this.regenerationDraftRows,
      create: (record) => this.createRegenerationDraft(record),
      createFromPlan: (plan, options) => this.createRegenerationDraftFromPlan(plan, options),
      get: (draftRecordId) => this.getRegenerationDraft(draftRecordId),
      getByPlanHash: (options) => this.getRegenerationDraftByPlanHash(options),
      listForSource: (options) => this.listRegenerationDraftsForSource(options),
      all: () => this.allRegenerationDrafts(),
      publicDraft: (record) => this.regenerationDraftView.publicDraft(record),
      restore: () => this.restoreRegenerationDrafts(),
      health: () => this.repositoryHealth("regeneration_drafts", { repository: "sqlite-regeneration-drafts", durable: true }),
    };
  }

  createRegenerationApprovalRepositoryFacade() {
    return {
      records: this.regenerationApprovalRows,
      createIdempotent: (record) => this.createRegenerationApprovalIdempotent(record),
      update: (approvalId, patch) => this.updateRegenerationApproval(approvalId, patch),
      markRenderQueued: (approvalId, jobId) => this.updateRegenerationApproval(approvalId, { status: "render_queued", newRenderJobId: jobId, errorCode: null }),
      markRenderProcessing: (approvalId, jobId) => this.updateRegenerationApproval(approvalId, { status: "render_processing", newRenderJobId: jobId, errorCode: null }),
      markRenderCompleted: (approvalId, options = {}) => this.updateRegenerationApproval(approvalId, {
        status: "render_completed",
        newRenderJobId: options.jobId,
        completedExportId: options.exportId,
        errorCode: null,
      }),
      markRenderFailed: (approvalId, options = {}) => this.updateRegenerationApproval(approvalId, {
        status: "render_failed",
        newRenderJobId: options.jobId,
        errorCode: options.errorCode || "RENDER_FAILED",
      }),
      markRenderCancelled: (approvalId, options = {}) => this.updateRegenerationApproval(approvalId, {
        status: "cancelled",
        newRenderJobId: options.jobId,
        errorCode: "JOB_CANCELLED",
      }),
      get: (approvalId) => this.getRegenerationApproval(approvalId),
      getByIdempotencyKey: (key) => this.getRegenerationApprovalByIdempotencyKey(key),
      getByRenderJobId: (jobId) => this.getRegenerationApprovalByRenderJobId(jobId),
      listForSource: (options) => this.listRegenerationApprovalsForSource(options),
      all: () => this.allRegenerationApprovals(),
      publicApproval: (record) => this.regenerationApprovalView.publicApproval(record),
      restore: () => this.restoreRegenerationApprovals(),
      health: () => this.repositoryHealth("regeneration_approvals", { repository: "sqlite-regeneration-approvals", durable: true }),
    };
  }

  createApprovalOutboxRepositoryFacade() {
    return {
      records: this.approvalOutboxRows,
      create: (record) => this.createApprovalOutboxEvent(record),
      createLifecycleEvent: (input) => this.createApprovalOutboxLifecycleEvent(input),
      get: (eventId) => this.getApprovalOutboxEvent(eventId),
      listPending: (limit) => this.listPendingApprovalOutboxEvents(limit),
      listDue: (options) => this.listDueApprovalOutboxEvents(options),
      claimDue: (options) => this.claimDueApprovalOutboxEvents(options),
      markDelivered: (eventId, options) => this.markApprovalOutboxDelivered(eventId, options),
      markProcessed: (eventId, updatedAt) => this.markApprovalOutboxDelivered(eventId, { updatedAt }),
      markFailed: (eventId, options) => this.markApprovalOutboxFailed(eventId, options),
      markDeadLetter: (eventId, options) => this.markApprovalOutboxDeadLetter(eventId, options),
      recoverStaleLocks: (options) => this.recoverStaleApprovalOutboxLocks(options),
      all: () => this.allApprovalOutboxEvents(),
      publicEvent: (record) => this.approvalOutboxView.publicEvent(record),
      restore: () => this.restoreApprovalOutboxEvents(),
      health: () => this.approvalOutboxHealth(),
    };
  }

  upsertProject(project) {
    this.prepare(
      `INSERT INTO projects (
        id, uploadId, schemaVersion, projectType, inputJson, language,
        title, status, ownerId, source, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET uploadId = excluded.uploadId,
       schemaVersion = excluded.schemaVersion, projectType = excluded.projectType,
       inputJson = excluded.inputJson, language = excluded.language, title = excluded.title,
       status = excluded.status, ownerId = excluded.ownerId, source = excluded.source,
       createdAt = excluded.createdAt, updatedAt = excluded.updatedAt`,
    ).run(
      project.id,
      project.uploadId,
      project.schemaVersion,
      project.projectType,
      stringifyRecord(project.input),
      project.language,
      project.title,
      project.status,
      project.ownerId || null,
      project.source,
      project.createdAt,
      project.updatedAt,
    );
    this.projectRows.set(project.id, project);
    return project;
  }

  createProject(record) {
    return this.upsertProject(normalizeProject(record));
  }

  persistProject({ project } = {}) {
    return this.createProject(project);
  }

  getProject(projectId) {
    const safeProjectId = validateResourceId(projectId, "prj");
    const row = this.prepare("SELECT * FROM projects WHERE id = ?").get(safeProjectId);
    if (!row) return null;
    const project = normalizeProject(row);
    this.projectRows.set(project.id, project);
    return project;
  }

  updateProject(projectId, patch = {}) {
    const current = this.getProject(projectId);
    if (!current) {
      throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
    }
    return this.upsertProject(normalizeProject({ ...current, ...patch, id: current.id, updatedAt: nowIso() }));
  }

  compareAndSwapProject({ projectId, expectedProject, patch = {} } = {}) {
    const safeProjectId = validateResourceId(projectId, "prj");
    if (!expectedProject || expectedProject.id !== safeProjectId) {
      throw new AppError(
        "VALIDATION_ERROR",
        SAFE_MESSAGES.VALIDATION_ERROR,
        400,
        { field: "expectedProject" },
      );
    }
    const expected = normalizeProject(expectedProject);
    const next = normalizeProject({
      ...expected,
      ...patch,
      id: safeProjectId,
      updatedAt: nowIso(),
    });
    const result = this.prepare(
      `UPDATE projects SET
        uploadId = ?, schemaVersion = ?, projectType = ?, inputJson = ?,
        language = ?, title = ?, status = ?, ownerId = ?, source = ?,
        createdAt = ?, updatedAt = ?
       WHERE id = ?
         AND uploadId IS ?
         AND schemaVersion IS ?
         AND projectType IS ?
         AND (inputJson IS ? OR (inputJson IS NULL AND ? = 'clip'))
         AND language IS ?
         AND title IS ?
         AND status IS ?
         AND ownerId IS ?
         AND source IS ?
         AND createdAt IS ?
         AND updatedAt IS ?`,
    ).run(
      next.uploadId,
      next.schemaVersion,
      next.projectType,
      stringifyRecord(next.input),
      next.language,
      next.title,
      next.status,
      next.ownerId || null,
      next.source,
      next.createdAt,
      next.updatedAt,
      safeProjectId,
      expected.uploadId,
      expected.schemaVersion,
      expected.projectType,
      stringifyRecord(expected.input),
      expected.projectType,
      expected.language,
      expected.title,
      expected.status,
      expected.ownerId || null,
      expected.source,
      expected.createdAt,
      expected.updatedAt,
    );
    if (Number(result && result.changes ? result.changes : 0) !== 1) {
      const row = this.prepare("SELECT * FROM projects WHERE id = ?").get(safeProjectId);
      if (row) {
        const current = normalizeProject(row);
        this.projectRows.set(current.id, current);
      } else {
        this.projectRows.delete(safeProjectId);
      }
      return null;
    }
    this.projectRows.set(next.id, next);
    return next;
  }

  deleteProject(projectId) {
    const safeProjectId = validateResourceId(projectId, "prj");
    const result = this.prepare("DELETE FROM projects WHERE id = ?").run(safeProjectId);
    this.projectRows.delete(safeProjectId);
    return Number(result && result.changes ? result.changes : 0) > 0;
  }

  publicProject(project) {
    return project ? jsonClone(normalizeProject(project)) : null;
  }

  createUpload(record) {
    const upload = normalizeUpload(record, { artifactStore: this.artifactAdapter });
    this.prepare(
      `INSERT INTO uploads (
        id, projectId, ownerId, artifactJson, storageKey, path, originalFilename, mimeType,
        extension, container, byteSize, checksumSha256, metadataJson, source, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET projectId = excluded.projectId, ownerId = excluded.ownerId, artifactJson = excluded.artifactJson,
      storageKey = excluded.storageKey, path = excluded.path, originalFilename = excluded.originalFilename,
      mimeType = excluded.mimeType, extension = excluded.extension, container = excluded.container,
      byteSize = excluded.byteSize, checksumSha256 = excluded.checksumSha256,
      metadataJson = excluded.metadataJson, source = excluded.source, createdAt = excluded.createdAt`,
    ).run(
      upload.id,
      upload.projectId,
      upload.ownerId || null,
      stringifyRecord(upload.artifact),
      upload.storageKey,
      upload.path,
      upload.originalFilename,
      upload.mimeType,
      upload.extension,
      upload.container,
      upload.byteSize,
      upload.checksumSha256,
      stringifyRecord(upload.metadata),
      upload.source,
      upload.createdAt,
    );
    this.uploadRows.set(upload.id, upload);
    this.createArtifact(upload.artifact);
    return upload;
  }

  uploadFromRow(row) {
    if (!row) return null;
    const upload = normalizeUpload({
      id: row.id,
      projectId: row.projectId,
      ownerId: row.ownerId || null,
      artifact: safeJsonParse(row.artifactJson),
      path: row.path,
      originalFilename: row.originalFilename,
      mimeType: row.mimeType,
      extension: row.extension,
      container: row.container,
      byteSize: row.byteSize,
      checksumSha256: row.checksumSha256,
      metadata: safeJsonParse(row.metadataJson, {}),
      source: row.source,
      createdAt: row.createdAt,
    }, { artifactStore: this.artifactAdapter });
    this.uploadRows.set(upload.id, upload);
    return upload;
  }

  getUpload(uploadId) {
    const safeUploadId = validateResourceId(uploadId, "upl");
    return this.uploadFromRow(this.prepare("SELECT * FROM uploads WHERE id = ?").get(safeUploadId));
  }

  deleteUpload(uploadId) {
    const safeUploadId = validateResourceId(uploadId, "upl");
    const result = this.prepare("DELETE FROM uploads WHERE id = ?").run(safeUploadId);
    this.uploadRows.delete(safeUploadId);
    return Number(result && result.changes ? result.changes : 0) > 0;
  }

  allUploads() {
    return this.prepare("SELECT * FROM uploads ORDER BY createdAt ASC").all().map((row) => this.uploadFromRow(row));
  }

  publicUpload(upload) {
    if (!upload) return null;
    return {
      id: upload.id,
      projectId: upload.projectId,
      ownerId: upload.ownerId || null,
      originalFilename: upload.originalFilename,
      byteSize: upload.byteSize,
      mimeType: upload.mimeType,
      metadata: jsonClone(upload.metadata),
      artifact: {
        id: upload.artifact.id,
        type: upload.artifact.type,
        status: upload.artifact.status,
        size: upload.artifact.size,
        createdAt: upload.artifact.createdAt,
      },
    };
  }

  createArtifact(record) {
    const artifact = normalizeArtifactRecord(record, { storageAdapterMode: this.storageAdapterMode });
    this.prepare(
      `INSERT INTO artifacts (
        id, type, status, ownerProjectId, ownerJobId, size, contentType, checksumSha256,
        storageAdapterMode, storageKey, path, createdAt, updatedAt, recordJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET type = excluded.type, status = excluded.status,
      ownerProjectId = excluded.ownerProjectId, ownerJobId = excluded.ownerJobId, size = excluded.size,
      contentType = excluded.contentType, checksumSha256 = excluded.checksumSha256,
      storageAdapterMode = excluded.storageAdapterMode, storageKey = excluded.storageKey,
      path = excluded.path, createdAt = excluded.createdAt, updatedAt = excluded.updatedAt,
      recordJson = excluded.recordJson`,
    ).run(
      artifact.id,
      artifact.type,
      artifact.status,
      artifact.ownerProjectId,
      artifact.ownerJobId,
      artifact.size,
      artifact.contentType,
      artifact.checksumSha256,
      artifact.storageAdapterMode,
      artifact.storageKey,
      artifact.path,
      artifact.createdAt,
      artifact.updatedAt,
      stringifyRecord(artifact),
    );
    this.artifactRows.set(artifact.id, artifact);
    return artifact;
  }

  artifactFromRow(row) {
    if (!row) return null;
    const artifact = normalizeArtifactRecord(safeJsonParse(row.recordJson, row), { storageAdapterMode: this.storageAdapterMode });
    this.artifactRows.set(artifact.id, artifact);
    return artifact;
  }

  getArtifact(artifactId) {
    const safeArtifactId = sanitizeText(artifactId, 160);
    const row = this.prepare("SELECT * FROM artifacts WHERE id = ?").get(safeArtifactId);
    return this.artifactFromRow(row);
  }

  updateArtifact(artifactId, patch = {}) {
    const current = this.getArtifact(artifactId);
    if (!current) throw new AppError("ARTIFACT_NOT_FOUND", SAFE_MESSAGES.ARTIFACT_NOT_FOUND, 404);
    return this.createArtifact({ ...current, ...patch, id: current.id, updatedAt: patch.updatedAt || nowIso() });
  }

  publicArtifact(artifact) {
    return publicArtifactRecord(artifact ? normalizeArtifactRecord(artifact, { storageAdapterMode: this.storageAdapterMode }) : null);
  }

  markArtifactDeleted(artifactId) {
    return this.updateArtifact(artifactId, { status: "deleted" });
  }

  markArtifactMissing(artifactId) {
    return this.updateArtifact(artifactId, { status: "missing" });
  }

  allArtifacts() {
    return this.prepare("SELECT * FROM artifacts ORDER BY createdAt ASC").all().map((row) => this.artifactFromRow(row));
  }

  listArtifactsForOwner({ projectId, jobId } = {}) {
    const safeProjectId = projectId ? validateResourceId(projectId, "prj") : null;
    const safeJobId = jobId ? validateResourceId(jobId, "job") : null;
    return this.allArtifacts().filter((record) => {
      if (safeProjectId && record.ownerProjectId !== safeProjectId) return false;
      if (safeJobId && record.ownerJobId !== safeJobId) return false;
      return true;
    });
  }

  listCleanupArtifactCandidates(options = {}) {
    const limit = Math.max(1, Math.min(Math.floor(Number(options.limit || options.maxArtifacts || CONFIG.storage.lifecycleCleanupMaxPerRun)), 1000));
    const maxAgeMs = Math.max(60, Number(options.maxAgeSeconds || CONFIG.storage.lifecycleCleanupMaxAgeSeconds)) * 1000;
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const activeJobIds = new Set(Array.isArray(options.activeJobIds) ? options.activeJobIds : []);
    const tempTypes = new Set(["extracted_audio", "audio", "subtitle_temp", "subtitles", "render_temp"]);
    const candidates = [];
    for (const artifact of this.allArtifacts()) {
      if (candidates.length >= limit) break;
      if (!tempTypes.has(artifact.type) || ["deleted", "missing"].includes(artifact.status)) continue;
      if (artifact.ownerJobId && activeJobIds.has(artifact.ownerJobId)) continue;
      const ageMs = nowMs - Date.parse(artifact.updatedAt || artifact.createdAt || "");
      if (Number.isFinite(ageMs) && ageMs >= maxAgeMs) candidates.push(artifact);
    }
    return candidates;
  }

  createExport(record) {
    const exportRecord = this.exportView.create(record);
    this.prepare(
      `INSERT INTO exports (id, projectId, jobId, ownerId, artifactJson, storageKey, outputPath, fileName, status, source, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET projectId = excluded.projectId, jobId = excluded.jobId,
       ownerId = excluded.ownerId,
       artifactJson = excluded.artifactJson, storageKey = excluded.storageKey, outputPath = excluded.outputPath,
       fileName = excluded.fileName, status = excluded.status, source = excluded.source, createdAt = excluded.createdAt`,
    ).run(
      exportRecord.id,
      exportRecord.projectId,
      exportRecord.jobId,
      exportRecord.ownerId || null,
      stringifyRecord(exportRecord.artifact),
      exportRecord.storageKey,
      exportRecord.outputPath,
      exportRecord.fileName,
      exportRecord.status,
      exportRecord.source,
      exportRecord.createdAt,
    );
    this.exportRows.set(exportRecord.id, exportRecord);
    this.createArtifact(exportRecord.artifact);
    return exportRecord;
  }

  exportFromRow(row) {
    if (!row) return null;
    const exportRecord = normalizeExport({
      id: row.id,
      projectId: row.projectId,
      jobId: row.jobId,
      ownerId: row.ownerId || null,
      artifact: safeJsonParse(row.artifactJson),
      outputPath: row.outputPath,
      fileName: row.fileName,
      status: row.status,
      source: row.source,
      createdAt: row.createdAt,
    }, { artifactStore: this.artifactAdapter });
    this.exportRows.set(exportRecord.id, exportRecord);
    return exportRecord;
  }

  getExport(exportId) {
    const safeExportId = validateResourceId(exportId, "exp");
    return this.exportFromRow(this.prepare("SELECT * FROM exports WHERE id = ?").get(safeExportId));
  }

  deleteExport(exportId) {
    const safeExportId = validateResourceId(exportId, "exp");
    const result = this.prepare("DELETE FROM exports WHERE id = ?").run(safeExportId);
    this.exportRows.delete(safeExportId);
    this.exportView.records.delete(safeExportId);
    return Number(result && result.changes ? result.changes : 0) > 0;
  }

  allExports() {
    return this.prepare("SELECT * FROM exports ORDER BY createdAt ASC").all().map((row) => this.exportFromRow(row));
  }

  publicExport(exportRecord) {
    return this.exportView.publicExport(exportRecord);
  }

  getExportDownloadDescriptor(exportRecord, options) {
    return this.exportView.getDownloadDescriptor(exportRecord, options);
  }

  createSignedExportDownload(exportRecord, options) {
    return this.exportView.createSignedDownload(exportRecord, options);
  }

  resolveExportOutputPath(exportRecord) {
    return this.exportView.resolveOutputPath(exportRecord);
  }

  upsertRegenerationDraft(record) {
    const draft = normalizeDraftRecord(record);
    this.prepare(
      `INSERT INTO regeneration_drafts (
        id, projectId, sourceJobId, sourceExportId, regenerationPlanId, draftHash,
        version, status, validationStatus, proposedEditPlanSummaryJson,
        appliedSuggestionIdsJson, skippedSuggestionIdsJson, proposedChangesJson,
        blockingReasonCodesJson, safetyChecksJson, createdAt, updatedAt, recordJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET projectId = excluded.projectId, sourceJobId = excluded.sourceJobId,
      sourceExportId = excluded.sourceExportId, regenerationPlanId = excluded.regenerationPlanId,
      draftHash = excluded.draftHash, version = excluded.version, status = excluded.status,
      validationStatus = excluded.validationStatus, proposedEditPlanSummaryJson = excluded.proposedEditPlanSummaryJson,
      appliedSuggestionIdsJson = excluded.appliedSuggestionIdsJson,
      skippedSuggestionIdsJson = excluded.skippedSuggestionIdsJson,
      proposedChangesJson = excluded.proposedChangesJson,
      blockingReasonCodesJson = excluded.blockingReasonCodesJson,
      safetyChecksJson = excluded.safetyChecksJson,
      createdAt = excluded.createdAt, updatedAt = excluded.updatedAt, recordJson = excluded.recordJson`,
    ).run(
      draft.id,
      draft.projectId,
      draft.sourceJobId,
      draft.sourceExportId,
      draft.regenerationPlanId,
      draft.draftHash,
      draft.version,
      draft.status,
      draft.validationStatus,
      stringifyRecord(draft.proposedEditPlanSummary || null),
      stringifyRecord(draft.appliedSuggestionIds),
      stringifyRecord(draft.skippedSuggestionIds),
      stringifyRecord(draft.proposedChanges),
      stringifyRecord(draft.blockingReasonCodes),
      stringifyRecord(draft.safetyChecks),
      draft.createdAt,
      draft.updatedAt,
      stringifyRecord(draft),
    );
    this.regenerationDraftRows.set(draft.id, draft);
    return draft;
  }

  createRegenerationDraft(record) {
    const draft = this.regenerationDraftView.create(record);
    return this.upsertRegenerationDraft(draft);
  }

  createRegenerationDraftFromPlan(plan, options = {}) {
    const draft = this.regenerationDraftView.createFromPlan(plan, options);
    return this.upsertRegenerationDraft(draft);
  }

  regenerationDraftFromRow(row) {
    if (!row) return null;
    const draft = normalizeDraftRecord(safeJsonParse(row.recordJson, row));
    this.regenerationDraftRows.set(draft.id, draft);
    return draft;
  }

  getRegenerationDraft(draftRecordId) {
    const safeId = sanitizeText(draftRecordId, 80);
    const row = this.prepare("SELECT recordJson FROM regeneration_drafts WHERE id = ?").get(safeId);
    return this.regenerationDraftFromRow(row);
  }

  getRegenerationDraftByPlanHash(options = {}) {
    const safePlanId = validateResourceId(options.regenerationPlanId, "regen");
    const safeHash = sanitizeText(options.draftHash, 80).toLowerCase();
    const safeProjectId = options.projectId ? validateResourceId(options.projectId, "prj") : null;
    const safeJobId = options.sourceJobId ? validateResourceId(options.sourceJobId, "job") : null;
    const safeExportId = options.sourceExportId ? validateResourceId(options.sourceExportId, "exp") : null;
    const rows = this.prepare(
      `SELECT recordJson FROM regeneration_drafts
       WHERE regenerationPlanId = ? AND draftHash = ?
       ORDER BY version ASC, createdAt ASC`,
    ).all(safePlanId, safeHash);
    return rows.map((row) => this.regenerationDraftFromRow(row)).find((record) => (
      (!safeProjectId || record.projectId === safeProjectId) &&
      (!safeJobId || record.sourceJobId === safeJobId) &&
      (!safeExportId || record.sourceExportId === safeExportId)
    )) || null;
  }

  listRegenerationDraftsForSource(options = {}) {
    const safeProjectId = options.projectId ? validateResourceId(options.projectId, "prj") : null;
    const safeJobId = (options.sourceJobId || options.jobId) ? validateResourceId(options.sourceJobId || options.jobId, "job") : null;
    const safeExportId = (options.sourceExportId || options.exportId) ? validateResourceId(options.sourceExportId || options.exportId, "exp") : null;
    return this.allRegenerationDrafts().filter((record) => (
      (!safeProjectId || record.projectId === safeProjectId) &&
      (!safeJobId || record.sourceJobId === safeJobId) &&
      (!safeExportId || record.sourceExportId === safeExportId)
    ));
  }

  allRegenerationDrafts() {
    return this.prepare("SELECT recordJson FROM regeneration_drafts ORDER BY projectId ASC, sourceJobId ASC, sourceExportId ASC, version ASC")
      .all()
      .map((row) => this.regenerationDraftFromRow(row))
      .filter(Boolean);
  }

  upsertRegenerationApproval(record) {
    const approval = normalizeApprovalRecord(record);
    this.prepare(
      `INSERT INTO regeneration_approvals (
        approvalId, projectId, sourceJobId, sourceExportId, regenerationPlanId,
        draftHash, idempotencyKey, draftRecordId, newRenderJobId, completedExportId,
        approvedAt, approvedBy, status, errorCode, createdAt, updatedAt, recordJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(approvalId) DO UPDATE SET projectId = excluded.projectId,
      sourceJobId = excluded.sourceJobId, sourceExportId = excluded.sourceExportId,
      regenerationPlanId = excluded.regenerationPlanId, draftHash = excluded.draftHash,
      idempotencyKey = excluded.idempotencyKey, draftRecordId = excluded.draftRecordId,
      newRenderJobId = excluded.newRenderJobId, completedExportId = excluded.completedExportId,
      approvedAt = excluded.approvedAt, approvedBy = excluded.approvedBy,
      status = excluded.status, errorCode = excluded.errorCode,
      createdAt = excluded.createdAt, updatedAt = excluded.updatedAt, recordJson = excluded.recordJson`,
    ).run(
      approval.approvalId,
      approval.projectId,
      approval.sourceJobId,
      approval.sourceExportId,
      approval.regenerationPlanId,
      approval.draftHash,
      approval.idempotencyKey,
      approval.draftRecordId,
      approval.newRenderJobId,
      approval.completedExportId,
      approval.approvedAt,
      approval.approvedBy,
      approval.status,
      approval.errorCode,
      approval.createdAt,
      approval.updatedAt,
      stringifyRecord(approval),
    );
    this.regenerationApprovalRows.set(approval.approvalId, approval);
    return approval;
  }

  createRegenerationApprovalIdempotent(record) {
    const normalized = normalizeApprovalRecord(record);
    const byKey = this.getRegenerationApprovalByIdempotencyKey(normalized.idempotencyKey);
    if (byKey) {
      if (!sameApprovalRequest(byKey, normalized)) {
        throw new AppError("VALIDATION_ERROR", "Approval idempotency key belongs to another draft.", 409, {
          field: "idempotencyKey",
          nextAction: "refresh-regeneration-draft",
        });
      }
      return byKey;
    }
    const byId = this.getRegenerationApproval(normalized.approvalId);
    if (byId) {
      if (!sameApprovalRequest(byId, normalized)) {
        throw new AppError("VALIDATION_ERROR", "Approval id belongs to another draft.", 409, {
          field: "approvalId",
          nextAction: "refresh-regeneration-draft",
        });
      }
      return byId;
    }
    return this.upsertRegenerationApproval(normalized);
  }

  updateRegenerationApproval(approvalId, patch = {}) {
    const current = this.getRegenerationApproval(approvalId);
    if (!current) throw new AppError("APPROVAL_NOT_FOUND", "Approval audit record was not found.", 404);
    return this.upsertRegenerationApproval({
      ...current,
      ...patch,
      approvalId: current.approvalId,
      idempotencyKey: current.idempotencyKey,
      projectId: current.projectId,
      sourceJobId: current.sourceJobId,
      sourceExportId: current.sourceExportId,
      regenerationPlanId: current.regenerationPlanId,
      draftHash: current.draftHash,
      updatedAt: patch.updatedAt || nowIso(),
    });
  }

  regenerationApprovalFromRow(row) {
    if (!row) return null;
    const approval = normalizeApprovalRecord(safeJsonParse(row.recordJson, row));
    this.regenerationApprovalRows.set(approval.approvalId, approval);
    return approval;
  }

  getRegenerationApproval(approvalId) {
    const safeId = sanitizeText(approvalId, 80);
    const row = this.prepare("SELECT recordJson FROM regeneration_approvals WHERE approvalId = ?").get(safeId);
    return this.regenerationApprovalFromRow(row);
  }

  getRegenerationApprovalByIdempotencyKey(key) {
    const safeKey = validateIdempotencyKey(key);
    const row = this.prepare("SELECT recordJson FROM regeneration_approvals WHERE idempotencyKey = ?").get(safeKey);
    return this.regenerationApprovalFromRow(row);
  }

  getRegenerationApprovalByRenderJobId(jobId) {
    const safeJobId = validateResourceId(jobId, "job");
    const row = this.prepare("SELECT recordJson FROM regeneration_approvals WHERE newRenderJobId = ? ORDER BY updatedAt DESC").get(safeJobId);
    return this.regenerationApprovalFromRow(row);
  }

  listRegenerationApprovalsForSource(options = {}) {
    const safeProjectId = options.projectId ? validateResourceId(options.projectId, "prj") : null;
    const safeJobId = (options.sourceJobId || options.jobId) ? validateResourceId(options.sourceJobId || options.jobId, "job") : null;
    const safeExportId = (options.sourceExportId || options.exportId) ? validateResourceId(options.sourceExportId || options.exportId, "exp") : null;
    return this.allRegenerationApprovals().filter((record) => (
      (!safeProjectId || record.projectId === safeProjectId) &&
      (!safeJobId || record.sourceJobId === safeJobId) &&
      (!safeExportId || record.sourceExportId === safeExportId)
    ));
  }

  allRegenerationApprovals() {
    return this.prepare("SELECT recordJson FROM regeneration_approvals ORDER BY createdAt ASC, approvalId ASC")
      .all()
      .map((row) => this.regenerationApprovalFromRow(row))
      .filter(Boolean);
  }

  upsertApprovalOutboxEvent(record) {
    const event = normalizeOutboxEvent(record);
    this.prepare(
      `INSERT INTO approval_outbox (
        id, eventType, approvalId, status, attempts, maxAttempts, nextAttemptAt,
        lockedAt, lockOwner, deliveredAt, lastErrorCode,
        payloadJson, createdAt, updatedAt, recordJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET eventType = excluded.eventType,
      approvalId = excluded.approvalId, status = excluded.status, attempts = excluded.attempts,
      maxAttempts = excluded.maxAttempts, nextAttemptAt = excluded.nextAttemptAt,
      lockedAt = excluded.lockedAt, lockOwner = excluded.lockOwner, deliveredAt = excluded.deliveredAt,
      lastErrorCode = excluded.lastErrorCode,
      payloadJson = excluded.payloadJson, createdAt = excluded.createdAt,
      updatedAt = excluded.updatedAt, recordJson = excluded.recordJson`,
    ).run(
      event.id,
      event.eventType,
      event.approvalId,
      event.status,
      event.attempts,
      event.maxAttempts,
      event.nextAttemptAt,
      event.lockedAt,
      event.lockOwner,
      event.deliveredAt,
      event.lastErrorCode,
      stringifyRecord(event.payload),
      event.createdAt,
      event.updatedAt,
      stringifyRecord(event),
    );
    this.approvalOutboxRows.set(event.id, event);
    return event;
  }

  createApprovalOutboxEvent(record) {
    const event = normalizeOutboxEvent(record);
    const existing = this.getApprovalOutboxEvent(event.id);
    if (existing) return existing;
    return this.upsertApprovalOutboxEvent(event);
  }

  createApprovalOutboxLifecycleEvent(input) {
    const event = this.approvalOutboxView.createLifecycleEvent(input);
    return this.createApprovalOutboxEvent(event);
  }

  updateApprovalOutboxEvent(eventId, patch = {}) {
    this.getApprovalOutboxEvent(eventId);
    const updated = this.approvalOutboxView.updateLifecycle(eventId, patch);
    return this.upsertApprovalOutboxEvent(updated);
  }

  listDueApprovalOutboxEvents(options = {}) {
    this.allApprovalOutboxEvents();
    return this.approvalOutboxView.listDue(options);
  }

  claimDueApprovalOutboxEvents(options = {}) {
    return this.transaction(() => {
      this.allApprovalOutboxEvents();
      const claimed = this.approvalOutboxView.claimDue(options);
      for (const event of claimed) this.upsertApprovalOutboxEvent(event);
      return claimed;
    });
  }

  markApprovalOutboxDelivered(eventId, options = {}) {
    return this.transaction(() => {
      this.getApprovalOutboxEvent(eventId);
      const updated = this.approvalOutboxView.markDelivered(eventId, options);
      return this.upsertApprovalOutboxEvent(updated);
    });
  }

  markApprovalOutboxFailed(eventId, options = {}) {
    return this.transaction(() => {
      this.getApprovalOutboxEvent(eventId);
      const updated = this.approvalOutboxView.markFailed(eventId, options);
      return this.upsertApprovalOutboxEvent(updated);
    });
  }

  markApprovalOutboxDeadLetter(eventId, options = {}) {
    return this.transaction(() => {
      this.getApprovalOutboxEvent(eventId);
      const updated = this.approvalOutboxView.markDeadLetter(eventId, options);
      return this.upsertApprovalOutboxEvent(updated);
    });
  }

  recoverStaleApprovalOutboxLocks(options = {}) {
    return this.transaction(() => {
      this.allApprovalOutboxEvents();
      const recovered = this.approvalOutboxView.recoverStaleLocks(options);
      for (const event of recovered) this.upsertApprovalOutboxEvent(event);
      return recovered;
    });
  }

  approvalOutboxEventFromRow(row) {
    if (!row) return null;
    const event = normalizeOutboxEvent(safeJsonParse(row.recordJson, row));
    this.approvalOutboxRows.set(event.id, event);
    return event;
  }

  getApprovalOutboxEvent(eventId) {
    const safeId = sanitizeText(eventId, 80);
    const row = this.prepare("SELECT recordJson FROM approval_outbox WHERE id = ?").get(safeId);
    return this.approvalOutboxEventFromRow(row);
  }

  listPendingApprovalOutboxEvents(limit = 100) {
    const max = Math.max(1, Math.min(500, Math.floor(Number(limit || 100))));
    return this.prepare("SELECT recordJson FROM approval_outbox WHERE status = 'pending' ORDER BY createdAt ASC, id ASC LIMIT ?")
      .all(max)
      .map((row) => this.approvalOutboxEventFromRow(row))
      .filter(Boolean);
  }

  allApprovalOutboxEvents() {
    return this.prepare("SELECT recordJson FROM approval_outbox ORDER BY createdAt ASC, id ASC")
      .all()
      .map((row) => this.approvalOutboxEventFromRow(row))
      .filter(Boolean);
  }

  restoreRegenerationDrafts() {
    let records = 0;
    let ignored = 0;
    for (const row of this.prepare("SELECT recordJson FROM regeneration_drafts ORDER BY createdAt ASC").all()) {
      try {
        if (this.regenerationDraftFromRow(row)) records += 1;
      } catch {
        ignored += 1;
      }
    }
    return { records, ignored };
  }

  restoreRegenerationApprovals() {
    let records = 0;
    let ignored = 0;
    for (const row of this.prepare("SELECT recordJson FROM regeneration_approvals ORDER BY createdAt ASC").all()) {
      try {
        if (this.regenerationApprovalFromRow(row)) records += 1;
      } catch {
        ignored += 1;
      }
    }
    return { records, ignored };
  }

  restoreApprovalOutboxEvents() {
    let records = 0;
    let ignored = 0;
    for (const row of this.prepare("SELECT recordJson FROM approval_outbox ORDER BY createdAt ASC").all()) {
      try {
        if (this.approvalOutboxEventFromRow(row)) records += 1;
      } catch {
        ignored += 1;
      }
    }
    return { records, ignored };
  }

  createProjectUpload({ project, upload } = {}) {
    return this.transaction(() => {
      const uploadRecord = this.createUpload(upload);
      const projectRecord = this.createProject(project);
      return { project: projectRecord, upload: uploadRecord };
    });
  }

  persistProjectUpload({ project, upload } = {}) {
    return this.transaction(() => {
      const uploadRecord = this.createUpload(upload);
      const projectRecord = this.createProject(project);
      return { project: projectRecord, upload: uploadRecord };
    });
  }

  persistJob(job) {
    if (!job || typeof job !== "object") return null;
    const record = jsonClone(job);
    delete record._controller;
    const jobId = validateResourceId(record.id, "job");
    const projectId = validateResourceId(record.projectId, "prj");
    const uploadId = record.uploadId ? validateResourceId(record.uploadId, "upl") : null;
    const ownerId = record.ownerId ? normalizeOwnerId(record.ownerId) : null;
    const progress = Math.max(0, Math.min(100, Math.round(Number(record.progress || 0))));
    const createdAt = sanitizeText(record.createdAt || nowIso(), 40);
    const updatedAt = sanitizeText(record.updatedAt || createdAt, 40);
    this.prepare(
      `INSERT INTO jobs (
        id, projectId, uploadId, ownerId, action, idempotencyKey, status, progress, step,
        errorJson, outputPath, exportId, payloadJson, createdAt, updatedAt, recordJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET projectId = excluded.projectId, uploadId = excluded.uploadId,
      ownerId = excluded.ownerId, action = excluded.action, idempotencyKey = excluded.idempotencyKey, status = excluded.status,
      progress = excluded.progress, step = excluded.step, errorJson = excluded.errorJson,
      outputPath = excluded.outputPath, exportId = excluded.exportId, payloadJson = excluded.payloadJson,
      createdAt = excluded.createdAt, updatedAt = excluded.updatedAt, recordJson = excluded.recordJson`,
    ).run(
      jobId,
      projectId,
      uploadId,
      ownerId,
      sanitizeText(record.action || "generate", 60),
      record.idempotencyKey || null,
      sanitizeText(record.status || "queued", 40),
      progress,
      record.step ? sanitizeText(record.step, 80) : null,
      stringifyRecord(record.error || null),
      record.outputPath ? assertStoragePath(record.outputPath, "renders") : null,
      record.exportId ? validateResourceId(record.exportId, "exp") : null,
      stringifyRecord(record.payload || null),
      createdAt,
      updatedAt,
      stringifyRecord({ ...record, id: jobId, projectId, uploadId, ownerId, progress, createdAt, updatedAt }),
    );
    if (record.idempotencyKey) this.persistIdempotencyKey(record.idempotencyKey, jobId, record.action || "generate");
    return this.getPersistedJob(jobId);
  }

  getPersistedJob(jobId) {
    const safeJobId = validateResourceId(jobId, "job");
    const row = this.prepare("SELECT recordJson FROM jobs WHERE id = ?").get(safeJobId);
    return row ? safeJsonParse(row.recordJson) : null;
  }

  listPersistedJobs() {
    return this.prepare("SELECT recordJson FROM jobs ORDER BY createdAt ASC, id ASC")
      .all()
      .map((row) => safeJsonParse(row.recordJson));
  }

  claimPersistedJob(options = {}) {
    const workerId = validateWorkerId(options.workerId);
    const leaseId = validateLeaseId(options.leaseId);
    const leaseMs = validateLeaseDurationMs(options.leaseMs);
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const maxAttempts = Math.max(1, Math.floor(Number(options.maxAttempts || 1)));
    const requestedJobId = options.jobId ? validateResourceId(options.jobId, "job") : null;
    return this.transaction(() => {
      const rows = requestedJobId
        ? this.prepare("SELECT recordJson FROM jobs WHERE id = ?").all(requestedJobId)
        : this.prepare("SELECT recordJson FROM jobs WHERE status IN ('queued', 'processing') ORDER BY createdAt ASC, id ASC").all();
      for (const row of rows) {
        const record = safeJsonParse(row.recordJson);
        if (!record || !["queued", "processing"].includes(record.status)) continue;
        if (record.status === "queued" && !retryDue(record, nowMs)) continue;
        if (record.status === "processing" && !leaseExpired(record, nowMs)) continue;
        try {
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
        } catch (error) {
          if (requestedJobId) throw error;
        }
      }
      return null;
    });
  }

  persistClaimedJob(job, lease = {}) {
    const record = jsonClone(job);
    const jobId = validateResourceId(record && record.id, "job");
    const workerId = validateWorkerId(lease.workerId);
    const leaseId = validateLeaseId(lease.leaseId);
    const nowMs = Number.isFinite(Number(lease.nowMs)) ? Number(lease.nowMs) : Date.now();
    return this.transaction(() => {
      const current = this.getPersistedJob(jobId);
      if (
        !current ||
        current.status !== "processing" ||
        current.workerId !== workerId ||
        current.leaseId !== leaseId ||
        leaseExpired(current, nowMs)
      ) {
        throw new AppError("JOB_LEASE_INVALID", SAFE_MESSAGES.JOB_LEASE_INVALID, 409);
      }
      return this.persistJob(record);
    });
  }

  persistIdempotencyKey(key, jobId, action = "generate") {
    const safeKey = validateIdempotencyKey(key);
    const safeJobId = validateResourceId(jobId, "job");
    const safeAction = sanitizeText(action || "generate", 60);
    const record = { key: safeKey, jobId: safeJobId, action: safeAction, createdAt: nowIso() };
    this.prepare(
      `INSERT INTO idempotency_keys (key, jobId, action, createdAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET jobId = excluded.jobId, action = excluded.action, createdAt = excluded.createdAt`,
    ).run(record.key, record.jobId, record.action, record.createdAt);
    return record;
  }

  getIdempotencyJobId(key) {
    const safeKey = validateIdempotencyKey(key);
    const row = this.prepare("SELECT jobId FROM idempotency_keys WHERE key = ?").get(safeKey);
    return row ? row.jobId : null;
  }

  persistRenderRecord(record) {
    if (!record || typeof record !== "object" || !record.project) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
    }
    const projectId = validateResourceId(record.project.id, "prj");
    const exportId = record.exportRecord && record.exportRecord.id ? validateResourceId(record.exportRecord.id, "exp") : null;
    const jobId = record.job && record.job.id ? validateResourceId(record.job.id, "job") : null;
    const existing = this.prepare("SELECT createdAt FROM render_records WHERE projectId = ?").get(projectId);
    const createdAt = existing && existing.createdAt ? existing.createdAt : nowIso();
    this.prepare(
      `INSERT INTO render_records (projectId, exportId, jobId, recordJson, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(projectId) DO UPDATE SET exportId = excluded.exportId, jobId = excluded.jobId,
       recordJson = excluded.recordJson, updatedAt = excluded.updatedAt`,
    ).run(projectId, exportId, jobId, stringifyRecord(record), createdAt, nowIso());
    return { projectId, exportId, jobId };
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

  completeRenderTransaction({ project, exportRecord, renderRecord } = {}) {
    return this.transaction(() => {
      const createdExport = this.createExport(exportRecord);
      const updatedProject = this.updateProject(project.id, { status: "ready" });
      const persistedRender = this.persistRenderRecord(renderRecord || { project: updatedProject, exportRecord: createdExport });
      return { project: updatedProject, exportRecord: createdExport, renderRecord: persistedRender };
    });
  }

  restoreState() {
    const summary = { records: 0, ignored: 0, artifacts: 0, exports: 0, uploads: 0, projects: 0 };
    for (const row of this.prepare("SELECT * FROM artifacts ORDER BY createdAt ASC").all()) {
      try {
        if (this.artifactFromRow(row)) {
          summary.records += 1;
          summary.artifacts += 1;
        }
      } catch {
        summary.ignored += 1;
      }
    }
    for (const row of this.prepare("SELECT * FROM uploads ORDER BY createdAt ASC").all()) {
      try {
        if (this.uploadFromRow(row)) {
          summary.records += 1;
          summary.uploads += 1;
        }
      } catch {
        summary.ignored += 1;
      }
    }
    for (const row of this.prepare("SELECT * FROM projects ORDER BY createdAt ASC").all()) {
      try {
        const project = normalizeProject(row);
        this.projectRows.set(project.id, project);
        summary.records += 1;
        summary.projects += 1;
      } catch {
        summary.ignored += 1;
      }
    }
    for (const row of this.prepare("SELECT * FROM exports ORDER BY createdAt ASC").all()) {
      try {
        if (this.exportFromRow(row)) {
          summary.records += 1;
          summary.exports += 1;
        }
      } catch {
        summary.ignored += 1;
      }
    }
    const draftAudits = this.restoreRegenerationDrafts();
    const approvalAudits = this.restoreRegenerationApprovals();
    const approvalOutbox = this.restoreApprovalOutboxEvents();
    summary.records += draftAudits.records + approvalAudits.records + approvalOutbox.records;
    summary.ignored += draftAudits.ignored + approvalAudits.ignored + approvalOutbox.ignored;
    summary.draftAudits = draftAudits.records;
    summary.approvalAudits = approvalAudits.records;
    summary.approvalOutbox = approvalOutbox.records;
    return summary;
  }

  repositoryHealth(tableName, extras = {}) {
    return {
      ready: true,
      total: rowCount(this.db, tableName),
      ...extras,
    };
  }

  projectHealth() {
    const statuses = Object.fromEntries(PROJECT_STATUSES.map((status) => [status, 0]));
    for (const row of this.prepare("SELECT status, COUNT(*) AS total FROM projects GROUP BY status").all()) {
      statuses[row.status] = Number(row.total || 0);
    }
    return {
      ready: true,
      total: rowCount(this.db, "projects"),
      statuses,
    };
  }

  artifactHealth() {
    const byStatus = Object.fromEntries(ARTIFACT_INDEX_STATUSES.map((status) => [status, 0]));
    const byType = {};
    for (const row of this.prepare("SELECT status, COUNT(*) AS total FROM artifacts GROUP BY status").all()) {
      byStatus[row.status] = Number(row.total || 0);
    }
    for (const row of this.prepare("SELECT type, COUNT(*) AS total FROM artifacts GROUP BY type").all()) {
      byType[row.type] = Number(row.total || 0);
    }
    return {
      ready: true,
      repository: "sqlite-artifact-index",
      durable: true,
      total: rowCount(this.db, "artifacts"),
      statuses: byStatus,
      types: byType,
    };
  }

  approvalOutboxHealth() {
    const health = this.approvalOutboxView.health();
    return {
      ...health,
      ready: true,
      repository: "sqlite-approval-outbox",
      durable: true,
      total: rowCount(this.db, "approval_outbox"),
    };
  }

  migrationHealth() {
    const applied = this.prepare("SELECT version, name, appliedAt FROM schema_migrations ORDER BY version ASC").all();
    const currentVersion = applied.reduce((max, row) => Math.max(max, Number(row.version || 0)), 0);
    return {
      ready: currentVersion >= LATEST_SCHEMA_VERSION,
      currentVersion,
      latestVersion: LATEST_SCHEMA_VERSION,
      applied: applied.map((row) => ({ version: Number(row.version), name: row.name, appliedAt: row.appliedAt })),
    };
  }

  health() {
    const migrations = this.migrationHealth();
    const repositories = {
      projects: this.projectHealth(),
      uploads: this.repositoryHealth("uploads"),
      artifacts: this.artifactHealth(),
      exports: this.repositoryHealth("exports", { completed: rowCount(this.db, "exports") }),
      jobs: this.repositoryHealth("jobs"),
      idempotency: this.repositoryHealth("idempotency_keys"),
      regenerationDrafts: this.repositoryHealth("regeneration_drafts", { repository: "sqlite-regeneration-drafts", durable: true }),
      regenerationApprovals: this.repositoryHealth("regeneration_approvals", { repository: "sqlite-regeneration-approvals", durable: true }),
      approvalOutbox: this.approvalOutboxHealth(),
      footballReviews: this.repositoryHealth("football_reviews", { repository: "sqlite-football-reviews", durable: true }),
    };
    return {
      ready: migrations.ready && Object.values(repositories).every((entry) => entry.ready),
      adapter: "sqlite-persistence",
      mode: "sqlite",
      database: true,
      dbEnabled: true,
      transactions: true,
      durable: true,
      schemaVersion: migrations.currentVersion,
      migrations,
      capabilities: persistenceAdapterCapabilities(this),
      repositories,
    };
  }

  close() {
    if (this.db && typeof this.db.close === "function") {
      this.db.close();
    }
  }
}

module.exports = {
  LATEST_SCHEMA_VERSION,
  SQLITE_AVAILABLE,
  SQLitePersistenceAdapter,
};
