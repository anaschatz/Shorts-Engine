const {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { randomUUID } = require("node:crypto");
const { join, resolve } = require("node:path");

const { AppError } = require("../../errors.cjs");
const {
  normalizeAnalyticsSnapshot,
  normalizePublishReceipt,
} = require("./growth-contracts.cjs");

const STORE_SCHEMA_VERSION = 1;
const STORE_FILE_NAME = "growth-store.json";
const MAX_RECORDS_PER_TYPE = 10000;

function storeError(code, field, message) {
  throw new AppError(code, message, 409, { field });
}

function safeHash(value, field) {
  const normalized = String(value || "").trim().toLowerCase().replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(normalized) || normalized === "0".repeat(64)) {
    storeError("GROWTH_STORE_INVALID", field, `${field} must be a non-placeholder sha256 hash.`);
  }
  return normalized;
}

function orderedRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function emptyState() {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    receiptsByIdempotencyKey: {},
    snapshotsByVideoGate: {},
  };
}

function atomicWriteJson(filePath, payload) {
  const directory = resolve(filePath, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${STORE_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
    try {
      const directoryDescriptor = openSync(directory, "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } catch {
      // Some filesystems do not support directory fsync; the file itself was synced.
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function normalizeState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    storeError("GROWTH_STORE_CORRUPT", "store", "Growth store is not an object.");
  }
  const allowed = new Set(["schemaVersion", "receiptsByIdempotencyKey", "snapshotsByVideoGate"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) storeError("GROWTH_STORE_CORRUPT", `store.${key}`, "Growth store contains an unsupported field.");
  }
  if (Number(input.schemaVersion) !== STORE_SCHEMA_VERSION) {
    storeError("GROWTH_STORE_CORRUPT", "store.schemaVersion", "Growth store schema is unsupported.");
  }
  if (!input.receiptsByIdempotencyKey || typeof input.receiptsByIdempotencyKey !== "object" || Array.isArray(input.receiptsByIdempotencyKey)) {
    storeError("GROWTH_STORE_CORRUPT", "store.receiptsByIdempotencyKey", "Receipt index is invalid.");
  }
  if (!input.snapshotsByVideoGate || typeof input.snapshotsByVideoGate !== "object" || Array.isArray(input.snapshotsByVideoGate)) {
    storeError("GROWTH_STORE_CORRUPT", "store.snapshotsByVideoGate", "Snapshot index is invalid.");
  }
  if (Object.keys(input.receiptsByIdempotencyKey).length > MAX_RECORDS_PER_TYPE || Object.keys(input.snapshotsByVideoGate).length > MAX_RECORDS_PER_TYPE) {
    storeError("GROWTH_STORE_CORRUPT", "store", "Growth store exceeds its bounded record limit.");
  }
  const receiptsByIdempotencyKey = {};
  for (const [key, value] of Object.entries(input.receiptsByIdempotencyKey)) {
    const safeKey = safeHash(key, "store.receiptKey");
    const receipt = normalizePublishReceipt(value);
    if (receipt.idempotencyKeyHash !== safeKey) {
      storeError("GROWTH_STORE_CORRUPT", "store.receiptKey", "Receipt is stored under the wrong idempotency key.");
    }
    receiptsByIdempotencyKey[safeKey] = receipt;
  }
  const snapshotsByVideoGate = {};
  for (const [key, value] of Object.entries(input.snapshotsByVideoGate)) {
    const snapshot = normalizeAnalyticsSnapshot(value);
    const expected = `${snapshot.videoId}:${snapshot.snapshotGateHours}`;
    if (key !== expected) {
      storeError("GROWTH_STORE_CORRUPT", "store.snapshotKey", "Snapshot is stored under the wrong equal-age key.");
    }
    snapshotsByVideoGate[key] = snapshot;
  }
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    receiptsByIdempotencyKey,
    snapshotsByVideoGate,
  };
}

class GrowthStore {
  constructor(rootDirectory, options = {}) {
    const root = String(rootDirectory || "").trim();
    if (!root) storeError("GROWTH_STORE_INVALID", "rootDirectory", "A growth store directory is required.");
    const fileName = String(options.fileName || STORE_FILE_NAME).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.json$/.test(fileName)) {
      storeError("GROWTH_STORE_INVALID", "fileName", "Growth store filename must be a local JSON basename.");
    }
    this.rootDirectory = resolve(root);
    this.filePath = join(this.rootDirectory, fileName);
  }

  readState() {
    if (!existsSync(this.filePath)) return emptyState();
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      storeError("GROWTH_STORE_CORRUPT", "store", "Growth store JSON is unreadable.");
    }
    return normalizeState(parsed);
  }

  writeState(state) {
    const normalized = normalizeState(state);
    atomicWriteJson(this.filePath, {
      schemaVersion: STORE_SCHEMA_VERSION,
      receiptsByIdempotencyKey: orderedRecord(normalized.receiptsByIdempotencyKey),
      snapshotsByVideoGate: orderedRecord(normalized.snapshotsByVideoGate),
    });
  }

  putPublishReceipt(receiptInput) {
    const receipt = normalizePublishReceipt(receiptInput);
    const state = this.readState();
    const existing = state.receiptsByIdempotencyKey[receipt.idempotencyKeyHash];
    if (existing) {
      if (existing.contentHash === receipt.contentHash) return { receipt: existing, replayed: true };
      storeError("GROWTH_IDEMPOTENCY_CONFLICT", "publishReceipt.idempotencyKeyHash", "Idempotency key already belongs to another publish receipt.");
    }
    for (const previous of Object.values(state.receiptsByIdempotencyKey)) {
      const duplicateField = ["youtubeVideoId", "outputHash", "candidateHash", "sourceHash", "sourceManifestHash"]
        .find((field) => previous[field] === receipt[field]);
      if (duplicateField) {
        storeError("GROWTH_DUPLICATE_PUBLISH", `publishReceipt.${duplicateField}`, `A publish receipt already owns this ${duplicateField}.`);
      }
    }
    if (Object.keys(state.receiptsByIdempotencyKey).length >= MAX_RECORDS_PER_TYPE) {
      storeError("GROWTH_STORE_LIMIT", "publishReceipt", "Receipt store limit reached.");
    }
    state.receiptsByIdempotencyKey[receipt.idempotencyKeyHash] = receipt;
    this.writeState(state);
    return { receipt, replayed: false };
  }

  getPublishReceiptByIdempotencyKey(value) {
    const key = safeHash(value, "idempotencyKeyHash");
    return this.readState().receiptsByIdempotencyKey[key] || null;
  }

  listPublishReceipts() {
    return Object.values(this.readState().receiptsByIdempotencyKey)
      .sort((left, right) => left.publishedAt.localeCompare(right.publishedAt) || left.youtubeVideoId.localeCompare(right.youtubeVideoId));
  }

  putAnalyticsSnapshot(snapshotInput) {
    const snapshot = normalizeAnalyticsSnapshot(snapshotInput);
    const state = this.readState();
    const key = `${snapshot.videoId}:${snapshot.snapshotGateHours}`;
    const existing = state.snapshotsByVideoGate[key];
    if (existing) {
      if (existing.contentHash === snapshot.contentHash) return { snapshot: existing, replayed: true, replaced: false };
      if (Date.parse(snapshot.observedAt) <= Date.parse(existing.observedAt)) {
        storeError("GROWTH_SNAPSHOT_CONFLICT", "analyticsSnapshot.observedAt", "A same-age snapshot cannot replace an equally new or newer artifact.");
      }
      for (const field of ["publishReceiptHash", "publishManifestHash", "experimentManifestHash", "experimentId", "cohortId", "treatmentId"] ) {
        if (snapshot[field] !== existing[field]) {
          storeError("GROWTH_SNAPSHOT_CONFLICT", `analyticsSnapshot.${field}`, "Replacement snapshot changes immutable bindings.");
        }
      }
      state.snapshotsByVideoGate[key] = snapshot;
      this.writeState(state);
      return { snapshot, replayed: false, replaced: true };
    }
    if (Object.keys(state.snapshotsByVideoGate).length >= MAX_RECORDS_PER_TYPE) {
      storeError("GROWTH_STORE_LIMIT", "analyticsSnapshot", "Snapshot store limit reached.");
    }
    state.snapshotsByVideoGate[key] = snapshot;
    this.writeState(state);
    return { snapshot, replayed: false, replaced: false };
  }

  listAnalyticsSnapshots(filters = {}) {
    const gate = filters.gateHours === undefined ? null : Number(filters.gateHours);
    const experimentId = filters.experimentId ? String(filters.experimentId) : null;
    return Object.values(this.readState().snapshotsByVideoGate)
      .filter((entry) => gate === null || entry.snapshotGateHours === gate)
      .filter((entry) => experimentId === null || entry.experimentId === experimentId)
      .sort((left, right) => left.snapshotGateHours - right.snapshotGateHours || left.videoId.localeCompare(right.videoId));
  }
}

module.exports = {
  GrowthStore,
  MAX_RECORDS_PER_TYPE,
  STORE_FILE_NAME,
  STORE_SCHEMA_VERSION,
  atomicWriteJson,
  normalizeState,
};
