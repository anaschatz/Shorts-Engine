import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";

const require = createRequire(import.meta.url);
const { createDefaultAdapters } = require("../../server/adapters/local-persistence-adapter.cjs");
const { CONFIG, ensureDataDirs } = require("../../server/config.cjs");
const { storagePath } = require("../../server/storage.cjs");
const {
  ACTIVE_JOB_STATUSES,
} = require("../../server/jobs.cjs");
const {
  STAGING_FULL_SMOKE_SOURCE,
  isStagingFullSmokeJob,
  isStagingFullSmokeSource,
} = require("../../server/staging-smoke-metadata.cjs");

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLEANUP_FLAG = "SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP";
const DEFAULT_MAX_AGE_SECONDS = 0;
const DEFAULT_MAX_COUNT = 20;
const MAX_JOB_RECORD_BYTES = 256 * 1024;
const JOB_FILE_RE = /^job_[A-Za-z0-9-]{8,80}\.json$/;
const ID_PATTERNS = Object.freeze({
  project: /^prj_[A-Za-z0-9-]{8,80}$/,
  upload: /^upl_[A-Za-z0-9-]{8,80}$/,
  job: /^job_[A-Za-z0-9-]{8,80}$/,
  export: /^exp_[A-Za-z0-9-]{8,80}$/,
  artifact: /^[A-Za-z0-9][A-Za-z0-9._:-]{1,159}$/,
});

class StagingFullSmokeCleanupError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "StagingFullSmokeCleanupError";
    this.code = code;
    this.details = details;
  }
}

function rawValue(env, name) {
  return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
}

function parseInteger(value, fallback, min, max, code) {
  const parsed = Number(value === undefined || value === null || value === "" ? fallback : value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new StagingFullSmokeCleanupError(code, "Full staging smoke cleanup numeric configuration is out of bounds.");
  }
  return parsed;
}

function cleanupEnabled(env = {}) {
  const value = rawValue(env, CLEANUP_FLAG);
  if (value === undefined || value === null || value === "") return false;
  if (String(value).trim() !== "1") {
    throw new StagingFullSmokeCleanupError(
      "STAGING_FULL_CLEANUP_FLAG_INVALID",
      "Full staging smoke cleanup requires SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP=1 for deletion.",
    );
  }
  return true;
}

function validateId(value, kind) {
  const text = String(value || "");
  if (!ID_PATTERNS[kind].test(text)) {
    throw new StagingFullSmokeCleanupError("STAGING_FULL_CLEANUP_RECORD_INVALID", "Full staging smoke cleanup record is invalid.");
  }
  return text;
}

function safeIsoMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function newestTimestampMs(records) {
  let newest = null;
  for (const record of records) {
    const parsed = safeIsoMs(record && (record.updatedAt || record.createdAt));
    if (parsed === null) return null;
    newest = newest === null ? parsed : Math.max(newest, parsed);
  }
  return newest;
}

function allFromRepository(repository) {
  if (!repository) return [];
  if (typeof repository.all === "function") return repository.all();
  if (repository.records && typeof repository.records.values === "function") return [...repository.records.values()];
  return [];
}

function safeJobRecord(record) {
  if (!record || typeof record !== "object") return null;
  try {
    return {
      id: validateId(record.id, "job"),
      projectId: validateId(record.projectId, "project"),
      uploadId: record.uploadId ? validateId(record.uploadId, "upload") : null,
      exportId: record.exportId ? validateId(record.exportId, "export") : null,
      status: String(record.status || ""),
      idempotencyKey: String(record.idempotencyKey || ""),
      payload: record.payload && typeof record.payload === "object" ? record.payload : null,
      source: record.source || null,
      createdAt: record.createdAt || null,
      updatedAt: record.updatedAt || null,
    };
  } catch {
    return null;
  }
}

function loadLocalJobRecords() {
  const records = [];
  const jobDir = storagePath("jobs", ".");
  if (!existsSync(jobDir)) return records;
  for (const fileName of readdirSync(jobDir).sort()) {
    if (!JOB_FILE_RE.test(fileName)) continue;
    try {
      const filePath = storagePath("jobs", fileName);
      const fileStat = statSync(filePath);
      if (!fileStat.isFile() || fileStat.size > MAX_JOB_RECORD_BYTES) continue;
      const job = safeJobRecord(JSON.parse(readFileSync(filePath, "utf8")));
      if (job) records.push(job);
    } catch {
      // Corrupt job records are ignored safely.
    }
  }
  return records;
}

function loadJobRecords({ persistenceAdapter, jobRecords } = {}) {
  if (Array.isArray(jobRecords)) return jobRecords.map(safeJobRecord).filter(Boolean);
  if (persistenceAdapter && persistenceAdapter.health && persistenceAdapter.health().database && typeof persistenceAdapter.listPersistedJobs === "function") {
    try {
      return persistenceAdapter.listPersistedJobs().map(safeJobRecord).filter(Boolean);
    } catch {
      return [];
    }
  }
  return loadLocalJobRecords();
}

function createDefaultState() {
  ensureDataDirs();
  const { artifactAdapter, persistenceAdapter } = createDefaultAdapters();
  persistenceAdapter.restoreState();
  return {
    artifactStore: artifactAdapter,
    persistenceAdapter,
    projectRepository: persistenceAdapter.projectRepository,
    uploadRepository: persistenceAdapter.uploadRepository,
    artifactRepository: persistenceAdapter.artifactRepository,
    exportRepository: persistenceAdapter.exportRepository,
  };
}

function normalizeState(options = {}) {
  const hasInjectedState = Boolean(
    options.artifactStore ||
      options.persistenceAdapter ||
      options.projectRepository ||
      options.uploadRepository ||
      options.artifactRepository ||
      options.exportRepository ||
      options.jobRecords,
  );
  const defaults = options.state || (hasInjectedState ? {} : createDefaultState());
  const persistenceAdapter = options.persistenceAdapter || defaults.persistenceAdapter;
  return {
    artifactStore: options.artifactStore || defaults.artifactStore,
    persistenceAdapter,
    projectRepository: options.projectRepository || defaults.projectRepository,
    uploadRepository: options.uploadRepository || defaults.uploadRepository,
    artifactRepository: options.artifactRepository || defaults.artifactRepository,
    exportRepository: options.exportRepository || defaults.exportRepository,
    jobRecords: loadJobRecords({ persistenceAdapter, jobRecords: options.jobRecords }),
  };
}

function artifactBelongsToSmokeChain(artifact, chain) {
  if (!artifact || !isStagingFullSmokeSource(artifact.source)) return false;
  if (artifact.ownerProjectId !== chain.project.id) return false;
  if (artifact.id === chain.upload.artifact?.id || artifact.id === chain.upload.id) return true;
  if (artifact.ownerJobId && chain.jobIds.has(artifact.ownerJobId)) return true;
  if (chain.exportIds.has(artifact.id)) return true;
  return false;
}

function validateChain(project, upload, jobs, exports, artifacts) {
  validateId(project.id, "project");
  validateId(project.uploadId, "upload");
  validateId(upload.id, "upload");
  if (upload.projectId !== project.id || upload.id !== project.uploadId) return false;
  if (!isStagingFullSmokeSource(project.source) || !isStagingFullSmokeSource(upload.source)) return false;
  if (!jobs.length || jobs.some((job) => job.projectId !== project.id || job.uploadId !== upload.id || !isStagingFullSmokeJob(job))) return false;
  for (const exportRecord of exports) {
    if (
      !exportRecord ||
      exportRecord.projectId !== project.id ||
      !jobs.some((job) => job.id === exportRecord.jobId) ||
      !isStagingFullSmokeSource(exportRecord.source || exportRecord.artifact?.source)
    ) {
      return false;
    }
  }
  for (const artifact of artifacts) validateId(artifact.id, "artifact");
  return true;
}

function buildCleanupPlan(options = {}) {
  const state = normalizeState(options);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const maxAgeSeconds = parseInteger(options.maxAgeSeconds, DEFAULT_MAX_AGE_SECONDS, 0, 365 * 24 * 60 * 60, "STAGING_FULL_CLEANUP_MAX_AGE_INVALID");
  const maxCount = parseInteger(options.maxCount, DEFAULT_MAX_COUNT, 1, 1000, "STAGING_FULL_CLEANUP_MAX_COUNT_INVALID");
  const uploads = allFromRepository(state.uploadRepository);
  const exports = allFromRepository(state.exportRepository);
  const artifacts = allFromRepository(state.artifactRepository);
  const chains = [];
  const stats = {
    scanned: 0,
    skippedUnmarked: 0,
    skippedInvalid: 0,
    skippedActive: 0,
    skippedYoung: 0,
  };

  for (const project of allFromRepository(state.projectRepository).sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))) {
    stats.scanned += 1;
    if (chains.length >= maxCount) break;
    try {
      validateId(project.id, "project");
      const upload = uploads.find((candidate) => candidate.id === project.uploadId && candidate.projectId === project.id);
      const projectJobs = state.jobRecords.filter((job) => job.projectId === project.id && job.uploadId === project.uploadId && isStagingFullSmokeJob(job));
      if (!upload || !isStagingFullSmokeSource(project.source) || !isStagingFullSmokeSource(upload.source) || projectJobs.length === 0) {
        stats.skippedUnmarked += 1;
        continue;
      }
      if (projectJobs.some((job) => ACTIVE_JOB_STATUSES.includes(job.status))) {
        stats.skippedActive += 1;
        continue;
      }
      const jobIds = new Set(projectJobs.map((job) => job.id));
      const projectExports = exports.filter((exportRecord) => exportRecord.projectId === project.id && jobIds.has(exportRecord.jobId));
      const exportIds = new Set(projectExports.map((exportRecord) => exportRecord.id));
      const chain = {
        project,
        upload,
        jobs: projectJobs,
        jobIds,
        exports: projectExports,
        exportIds,
        artifacts: [],
      };
      chain.artifacts = artifacts.filter((artifact) => artifactBelongsToSmokeChain(artifact, chain));
      if (!validateChain(project, upload, projectJobs, projectExports, chain.artifacts)) {
        stats.skippedInvalid += 1;
        continue;
      }
      const ageBase = newestTimestampMs([project, upload, ...projectJobs, ...projectExports, ...chain.artifacts]);
      if (ageBase === null) {
        stats.skippedInvalid += 1;
        continue;
      }
      if (nowMs - ageBase < maxAgeSeconds * 1000) {
        stats.skippedYoung += 1;
        continue;
      }
      chains.push(chain);
    } catch {
      stats.skippedInvalid += 1;
    }
  }

  return {
    state,
    maxAgeSeconds,
    maxCount,
    nowMs,
    chains,
    stats,
  };
}

function safeUnlink(filePath) {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function deleteLocalStateFiles(chain) {
  let deleted = 0;
  for (const filePath of [
    storagePath("projects", `${chain.project.id}.json`),
    storagePath("projects", `${chain.project.id}.render.json`),
  ]) {
    if (safeUnlink(filePath)) deleted += 1;
  }
  for (const job of chain.jobs) {
    if (safeUnlink(storagePath("jobs", `${job.id}.json`))) deleted += 1;
  }
  return deleted;
}

function deleteSqliteRows(persistenceAdapter, chain) {
  if (!persistenceAdapter || !persistenceAdapter.db || typeof persistenceAdapter.prepare !== "function") return 0;
  let deleted = 0;
  const statements = [
    ["DELETE FROM exports WHERE id = ?", chain.exports.map((record) => record.id)],
    ["DELETE FROM uploads WHERE id = ?", [chain.upload.id]],
    ["DELETE FROM projects WHERE id = ?", [chain.project.id]],
    ["DELETE FROM jobs WHERE id = ?", chain.jobs.map((job) => job.id)],
    ["DELETE FROM idempotency_keys WHERE jobId = ?", chain.jobs.map((job) => job.id)],
    ["DELETE FROM render_records WHERE projectId = ?", [chain.project.id]],
  ];
  for (const [sql, ids] of statements) {
    for (const id of ids) {
      const result = persistenceAdapter.prepare(sql).run(id);
      deleted += Number(result && result.changes ? result.changes : 0);
    }
  }
  return deleted;
}

function deleteRepositoryRows(state, chain) {
  let deleted = 0;
  for (const exportRecord of chain.exports) {
    if (state.exportRepository && typeof state.exportRepository.delete === "function" && state.exportRepository.delete(exportRecord.id)) deleted += 1;
  }
  if (state.uploadRepository && typeof state.uploadRepository.delete === "function" && state.uploadRepository.delete(chain.upload.id)) deleted += 1;
  if (state.projectRepository && typeof state.projectRepository.delete === "function" && state.projectRepository.delete(chain.project.id)) deleted += 1;
  if (state.persistenceAdapter && state.persistenceAdapter.persistedJobs) {
    for (const job of chain.jobs) {
      if (state.persistenceAdapter.persistedJobs.delete(job.id)) deleted += 1;
    }
  }
  return deleted;
}

function deleteArtifacts(state, chain) {
  let deleted = 0;
  let errors = 0;
  for (const artifact of chain.artifacts) {
    try {
      state.artifactStore.deleteMarkedArtifact(artifact, { source: STAGING_FULL_SMOKE_SOURCE });
      if (state.artifactRepository && typeof state.artifactRepository.markDeleted === "function") {
        state.artifactRepository.markDeleted(artifact.id);
      }
      deleted += 1;
    } catch {
      errors += 1;
    }
  }
  return { deleted, errors };
}

function executeCleanupPlan(plan, options = {}) {
  const dryRun = options.dryRun !== false;
  const summary = {
    dryRun,
    scanned: plan.stats.scanned,
    eligible: plan.chains.length,
    deleted: 0,
    deletedArtifacts: 0,
    deletedRecords: 0,
    skippedActive: plan.stats.skippedActive,
    skippedYoung: plan.stats.skippedYoung,
    skippedUnmarked: plan.stats.skippedUnmarked,
    skippedInvalid: plan.stats.skippedInvalid,
    errors: 0,
  };
  if (dryRun) return summary;

  for (const chain of plan.chains) {
    const artifactResult = deleteArtifacts(plan.state, chain);
    const repositoryRows = deleteRepositoryRows(plan.state, chain);
    const sqliteRows = deleteSqliteRows(plan.state.persistenceAdapter, chain);
    const localFiles = deleteLocalStateFiles(chain);
    summary.deletedArtifacts += artifactResult.deleted;
    summary.deletedRecords += repositoryRows + sqliteRows + localFiles;
    summary.errors += artifactResult.errors;
  }
  summary.deleted = summary.deletedArtifacts + summary.deletedRecords;
  return summary;
}

function assertNoSensitiveSummary(summary) {
  const leak = findSensitiveLeak(summary);
  if (leak) {
    throw new StagingFullSmokeCleanupError("STAGING_FULL_CLEANUP_SUMMARY_LEAK", "Full staging smoke cleanup summary contains sensitive data.", {
      leakCode: leak.code,
      leakPath: leak.path,
    });
  }
}

function cleanupConfig(env = {}) {
  const deleteEnabled = cleanupEnabled(env);
  return {
    dryRun: !deleteEnabled,
    maxAgeSeconds: parseInteger(
      rawValue(env, "SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP_MAX_AGE_SECONDS"),
      DEFAULT_MAX_AGE_SECONDS,
      0,
      365 * 24 * 60 * 60,
      "STAGING_FULL_CLEANUP_MAX_AGE_INVALID",
    ),
    maxCount: parseInteger(
      rawValue(env, "SHORTSENGINE_STAGING_FULL_SMOKE_CLEANUP_MAX_COUNT"),
      DEFAULT_MAX_COUNT,
      1,
      1000,
      "STAGING_FULL_CLEANUP_MAX_COUNT_INVALID",
    ),
  };
}

async function runStagingFullSmokeCleanup(options = {}) {
  const env = options.env || process.env;
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const config = cleanupConfig(env);
  const plan = buildCleanupPlan({
    ...options,
    nowMs,
    maxAgeSeconds: config.maxAgeSeconds,
    maxCount: config.maxCount,
  });
  const result = executeCleanupPlan(plan, { dryRun: config.dryRun });
  const summary = {
    ok: result.errors === 0,
    checkedAt: new Date(nowMs).toISOString(),
    mode: "staging-full-smoke-cleanup",
    source: STAGING_FULL_SMOKE_SOURCE,
    dryRun: result.dryRun,
    cleanupEnabled: !result.dryRun,
    scanned: result.scanned,
    eligible: result.eligible,
    deleted: result.deleted,
    deletedArtifacts: result.deletedArtifacts,
    deletedRecords: result.deletedRecords,
    skippedActive: result.skippedActive,
    skippedYoung: result.skippedYoung,
    skippedUnmarked: result.skippedUnmarked,
    skippedInvalid: result.skippedInvalid,
    errors: result.errors,
    bounds: {
      maxAgeSeconds: config.maxAgeSeconds,
      maxCount: config.maxCount,
    },
    protected: {
      nonSmokeArtifacts: true,
      activeJobs: true,
      ownershipChainRequired: true,
    },
  };
  assertNoSensitiveSummary(summary);
  return summary;
}

function safeError(error) {
  return {
    ok: false,
    code: error && error.code ? error.code : "STAGING_FULL_CLEANUP_FAILED",
    message: error && error.message ? error.message : "Full staging smoke cleanup failed.",
  };
}

function isMainModule() {
  return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
}

if (isMainModule()) {
  try {
    console.log(JSON.stringify(await runStagingFullSmokeCleanup(), null, 2));
  } catch (error) {
    console.error(JSON.stringify(safeError(error), null, 2));
    process.exitCode = 1;
  }
}

export {
  CLEANUP_FLAG,
  DEFAULT_MAX_AGE_SECONDS,
  DEFAULT_MAX_COUNT,
  ROOT_DIR,
  STAGING_FULL_SMOKE_SOURCE,
  StagingFullSmokeCleanupError,
  buildCleanupPlan,
  cleanupConfig,
  executeCleanupPlan,
  runStagingFullSmokeCleanup,
  safeError,
};
