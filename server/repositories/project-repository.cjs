const { AppError, SAFE_MESSAGES } = require("../errors.cjs");
const { jsonClone, nowIso, sanitizeText, validateResourceId } = require("./ids.cjs");

const PROJECT_STATUSES = Object.freeze(["draft", "processing", "ready", "failed", "cancelled"]);

function normalizeProject(record = {}) {
  const id = validateResourceId(record.id, "prj");
  const uploadId = validateResourceId(record.uploadId, "upl");
  const status = sanitizeText(record.status || "draft", 40);
  if (!PROJECT_STATUSES.includes(status)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
  }
  const createdAt = record.createdAt || nowIso();
  return {
    id,
    uploadId,
    title: sanitizeText(record.title || "ShortsEngine Short", 120),
    status,
    createdAt,
    updatedAt: record.updatedAt || createdAt,
  };
}

class InMemoryProjectRepository {
  constructor(options = {}) {
    this.records = options.records || new Map();
  }

  create(record) {
    const project = normalizeProject(record);
    this.records.set(project.id, project);
    return project;
  }

  save(record) {
    return this.create(record);
  }

  get(projectId) {
    return this.records.get(validateResourceId(projectId, "prj")) || null;
  }

  update(projectId, patch = {}) {
    const current = this.get(projectId);
    if (!current) {
      throw new AppError("PROJECT_NOT_FOUND", SAFE_MESSAGES.PROJECT_NOT_FOUND, 404);
    }
    const next = normalizeProject({ ...current, ...patch, id: current.id, updatedAt: nowIso() });
    this.records.set(next.id, next);
    Object.assign(current, next);
    return current;
  }

  delete(projectId) {
    return this.records.delete(validateResourceId(projectId, "prj"));
  }

  all() {
    return [...this.records.values()];
  }

  publicProject(project) {
    return project ? jsonClone(normalizeProject(project)) : null;
  }

  health() {
    const statuses = Object.fromEntries(PROJECT_STATUSES.map((status) => [status, 0]));
    for (const project of this.records.values()) {
      statuses[project.status] = (statuses[project.status] || 0) + 1;
    }
    return {
      ready: true,
      total: this.records.size,
      statuses,
    };
  }
}

module.exports = {
  InMemoryProjectRepository,
  PROJECT_STATUSES,
  normalizeProject,
};
