const { mkdirSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { CONFIG } = require("../config.cjs");
const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { InMemoryExportRepository, normalizeExport } = require("../repositories/export-repository.cjs");
const { normalizeArtifactRecord, publicArtifactRecord, ARTIFACT_INDEX_STATUSES } = require("../repositories/artifact-repository.cjs");
const { PROJECT_STATUSES, normalizeProject } = require("../repositories/project-repository.cjs");
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

const LATEST_SCHEMA_VERSION = 2;
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
]);

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
  return Number(db.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get().total || 0);
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
    this.exportView = new InMemoryExportRepository({ artifactStore: this.artifactAdapter });
    this.transactionDepth = 0;
    this.migrationVersion = 0;
    this.projectRepository = this.createProjectRepositoryFacade();
    this.uploadRepository = this.createUploadRepositoryFacade();
    this.artifactRepository = this.createArtifactRepositoryFacade();
    this.exportRepository = this.createExportRepositoryFacade();
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
      for (const [key, value] of snapshot.projects) this.projectRows.set(key, value);
      for (const [key, value] of snapshot.uploads) this.uploadRows.set(key, value);
      for (const [key, value] of snapshot.artifacts) this.artifactRows.set(key, value);
      for (const [key, value] of snapshot.exports) this.exportRows.set(key, value);
      for (const [key, value] of snapshot.exportView) this.exportView.records.set(key, value);
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

  upsertProject(project) {
    this.prepare(
      `INSERT INTO projects (id, uploadId, title, status, source, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET uploadId = excluded.uploadId, title = excluded.title,
       status = excluded.status, source = excluded.source, createdAt = excluded.createdAt, updatedAt = excluded.updatedAt`,
    ).run(project.id, project.uploadId, project.title, project.status, project.source, project.createdAt, project.updatedAt);
    this.projectRows.set(project.id, project);
    return project;
  }

  createProject(record) {
    return this.upsertProject(normalizeProject(record));
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
        id, projectId, artifactJson, storageKey, path, originalFilename, mimeType,
        extension, container, byteSize, checksumSha256, metadataJson, source, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET projectId = excluded.projectId, artifactJson = excluded.artifactJson,
      storageKey = excluded.storageKey, path = excluded.path, originalFilename = excluded.originalFilename,
      mimeType = excluded.mimeType, extension = excluded.extension, container = excluded.container,
      byteSize = excluded.byteSize, checksumSha256 = excluded.checksumSha256,
      metadataJson = excluded.metadataJson, source = excluded.source, createdAt = excluded.createdAt`,
    ).run(
      upload.id,
      upload.projectId,
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
      `INSERT INTO exports (id, projectId, jobId, artifactJson, storageKey, outputPath, fileName, status, source, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET projectId = excluded.projectId, jobId = excluded.jobId,
       artifactJson = excluded.artifactJson, storageKey = excluded.storageKey, outputPath = excluded.outputPath,
       fileName = excluded.fileName, status = excluded.status, source = excluded.source, createdAt = excluded.createdAt`,
    ).run(
      exportRecord.id,
      exportRecord.projectId,
      exportRecord.jobId,
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
    const progress = Math.max(0, Math.min(100, Math.round(Number(record.progress || 0))));
    const createdAt = sanitizeText(record.createdAt || nowIso(), 40);
    const updatedAt = sanitizeText(record.updatedAt || createdAt, 40);
    this.prepare(
      `INSERT INTO jobs (
        id, projectId, uploadId, action, idempotencyKey, status, progress, step,
        errorJson, outputPath, exportId, payloadJson, createdAt, updatedAt, recordJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET projectId = excluded.projectId, uploadId = excluded.uploadId,
      action = excluded.action, idempotencyKey = excluded.idempotencyKey, status = excluded.status,
      progress = excluded.progress, step = excluded.step, errorJson = excluded.errorJson,
      outputPath = excluded.outputPath, exportId = excluded.exportId, payloadJson = excluded.payloadJson,
      createdAt = excluded.createdAt, updatedAt = excluded.updatedAt, recordJson = excluded.recordJson`,
    ).run(
      jobId,
      projectId,
      uploadId,
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
      stringifyRecord({ ...record, id: jobId, projectId, uploadId, progress, createdAt, updatedAt }),
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
