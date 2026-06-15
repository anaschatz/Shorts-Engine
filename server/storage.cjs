const {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} = require("node:fs");
const { dirname, isAbsolute, join, relative, resolve } = require("node:path");
const { CONFIG, ensureDataDirs } = require("./config.cjs");
const { AppError, SAFE_MESSAGES } = require("./errors.cjs");

const STORAGE_ROOTS = Object.freeze({
  data: CONFIG.dataDir,
  uploads: CONFIG.uploadDir,
  audio: CONFIG.audioDir,
  renders: CONFIG.renderDir,
  projects: CONFIG.projectDir,
  jobs: CONFIG.jobDir,
  artifacts: CONFIG.artifactDir,
  db: CONFIG.dbDir,
  tmp: CONFIG.tmpDir,
  staging: CONFIG.stagingDir,
});

function isInside(baseDir, candidatePath) {
  const base = resolve(baseDir);
  const target = resolve(candidatePath);
  const pathFromBase = relative(base, target);
  return pathFromBase === "" || (!pathFromBase.startsWith("..") && !isAbsolute(pathFromBase));
}

function safeResolve(baseDir, candidate) {
  const target = resolve(baseDir, candidate || ".");
  if (!isInside(baseDir, target)) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  return target;
}

function storagePath(area, fileName) {
  const baseDir = STORAGE_ROOTS[area];
  if (!baseDir) throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  return safeResolve(baseDir, fileName);
}

function assertStoragePath(filePath, area = "data") {
  const baseDir = STORAGE_ROOTS[area];
  if (!baseDir || !isInside(baseDir, filePath)) {
    throw new AppError("STORAGE_PATH_UNSAFE", SAFE_MESSAGES.STORAGE_PATH_UNSAFE, 403);
  }
  return resolve(filePath);
}

function writeJsonAtomic(filePath, payload) {
  assertStoragePath(filePath, "data");
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function readJsonFile(filePath) {
  assertStoragePath(filePath, "projects");
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function storageHealth() {
  ensureDataDirs();
  return Object.fromEntries(
    Object.entries(STORAGE_ROOTS)
      .filter(([area]) => area !== "data")
      .map(([area, dir]) => {
        const exists = existsSync(dir);
        let readable = false;
        let writable = false;
        try {
          accessSync(dir, constants.R_OK);
          readable = true;
        } catch {
          readable = false;
        }
        try {
          accessSync(dir, constants.W_OK);
          writable = true;
        } catch {
          writable = false;
        }
        return [area, { exists, readable, writable }];
      }),
  );
}

module.exports = {
  STORAGE_ROOTS,
  isInside,
  safeResolve,
  storagePath,
  assertStoragePath,
  writeJsonAtomic,
  readJsonFile,
  storageHealth,
};
