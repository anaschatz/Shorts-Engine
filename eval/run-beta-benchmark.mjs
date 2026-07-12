import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { buildBetaBenchmark } = require("./beta-benchmark.cjs");
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argValue(argv, name, fallback) {
  const prefix = `--${name}=`;
  const found = argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function atomicWrite(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, filePath);
}

function runBetaBenchmark(options = {}) {
  const rootDir = resolve(options.rootDir || ROOT_DIR);
  const manifestPath = resolve(rootDir, options.manifest || "eval/beta-dataset.json");
  const outputPath = resolve(rootDir, options.output || "eval/results/beta-latest.json");
  let manifest = { datasetId: "beta-evaluation", matches: [] };
  let manifestAvailable = false;
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifestAvailable = true;
  }
  const report = buildBetaBenchmark(manifest, { rootDir, now: options.now });
  const output = {
    ...report,
    manifestAvailable,
    nextAction: manifestAvailable
      ? report.productionBetaReady ? "retain-beta-quality-and-monitor" : "complete-failed-beta-checks"
      : "create-eval-beta-dataset-from-example",
  };
  atomicWrite(outputPath, output);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runBetaBenchmark({
    manifest: argValue(process.argv.slice(2), "manifest", "eval/beta-dataset.json"),
    output: argValue(process.argv.slice(2), "output", "eval/results/beta-latest.json"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.productionBetaReady ? 0 : 2;
}

export { runBetaBenchmark };
