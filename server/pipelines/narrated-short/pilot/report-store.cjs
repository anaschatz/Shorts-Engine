const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { normalizePilotReport } = require("./contract.cjs");

function writeAtomic(path, value) { const temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); renameSync(temp, path); }
function persistPilotReport(reportInput, outputDir) {
  const report = normalizePilotReport(reportInput); const dir = resolve(outputDir); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const timestamp = report.completedAt.replace(/[:.]/g, "-"); const timestampedPath = join(dir, `pilot-${timestamp}-${report.runId.slice(-12)}.json`); const latestPath = join(dir, "latest.json");
  writeAtomic(timestampedPath, report); writeAtomic(latestPath, report); return report;
}
function readLatestPilotReport(outputDir) { const path = join(resolve(outputDir), "latest.json"); if (!existsSync(path)) return null; return normalizePilotReport(JSON.parse(readFileSync(path, "utf8"))); }

module.exports = { persistPilotReport, readLatestPilotReport };
