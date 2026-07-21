import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  MOTION_CALIBRATION_CORPUS_PROFILE_ID,
  MOTION_CALIBRATION_THRESHOLD_MODE,
  MOTION_CALIBRATION_EVIDENCE_TRUST_LEVEL,
  MINIMUM_ARTIFACT_BOUND_STORIES,
  MINIMUM_LABEL_SUPPORT,
  motionCalibrationCaseFromArtifacts,
  buildMotionCalibrationCorpusReport,
} = require("../server/pipelines/narrated-short/animation/motion-calibration-corpus.cjs");
const {
  ContentArtifactRepository,
} = require("../server/repositories/content-artifact-repository.cjs");
const {
  InMemoryArtifactRepository,
} = require("../server/repositories/artifact-repository.cjs");
const {
  LocalArtifactStore,
} = require("../server/storage/artifact-store.cjs");

const MAXIMUM_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_CASE_RESOLUTION_CONCURRENCY = 4;
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function readBundle(inputPath) {
  let bytes;
  try {
    const stats = statSync(inputPath);
    if (!stats.isFile() || stats.size < 2 || stats.size > MAXIMUM_BUNDLE_BYTES) {
      throw new Error("invalid_size");
    }
    bytes = readFileSync(inputPath);
  } catch {
    throw new Error("Motion calibration bundle is unavailable or out of bounds.");
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Motion calibration bundle is not valid JSON.");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || Object.getPrototypeOf(parsed) !== Object.prototype
    || Object.keys(parsed).sort().join("|") !== "cases|schemaVersion"
    || parsed.schemaVersion !== 2
    || !Array.isArray(parsed.cases)
    || parsed.cases.length < 1
    || parsed.cases.length > 1000
  ) throw new Error("Motion calibration bundle contract is invalid.");
  return parsed;
}

function localContentArtifactRepository() {
  const artifactRepository = new InMemoryArtifactRepository({ persist: true });
  artifactRepository.restore();
  return new ContentArtifactRepository({
    artifactRepository,
    artifactStore: new LocalArtifactStore(),
  });
}

function writeReport(outputPath, report) {
  const target = resolve(outputPath);
  const parent = dirname(target);
  const temporary = resolve(
    parent,
    `.${basename(target)}.tmp-${process.pid}`,
  );
  mkdirSync(parent, { recursive: true });
  try {
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function resolveCases(entries, contentArtifactRepository, resolver) {
  const cases = new Array(entries.length);
  let nextIndex = 0;
  let failed = false;
  let firstError;
  const worker = async () => {
    while (!failed) {
      const index = nextIndex;
      if (index >= entries.length) return;
      nextIndex += 1;
      try {
        cases[index] = await resolver({
          ...entries[index],
          contentArtifactRepository,
        });
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  };
  await Promise.all(Array.from(
    {
      length: Math.min(
        MAXIMUM_CASE_RESOLUTION_CONCURRENCY,
        entries.length,
      ),
    },
    () => worker(),
  ));
  if (failed) throw firstError;
  return cases;
}

export async function runCli(args = process.argv.slice(2), dependencies = {}) {
  const command = args[0] || "doctor";
  if (command === "doctor") {
    return {
      ready: true,
      profileId: MOTION_CALIBRATION_CORPUS_PROFILE_ID,
      thresholdMode: MOTION_CALIBRATION_THRESHOLD_MODE,
      evidenceTrustLevel: MOTION_CALIBRATION_EVIDENCE_TRUST_LEVEL,
      artifactBoundEvidenceRequired: true,
      repositoryReadRequired: true,
      artifactIdManifestSchemaVersion: 2,
      humanReviewRequired: true,
      minimumDistinctStories: MINIMUM_ARTIFACT_BOUND_STORIES,
      minimumPassAndFailLabelsPerMetric: MINIMUM_LABEL_SUPPORT,
      productionThresholdsApproved: false,
      externalNetworkRequired: false,
      apiKeyRequired: false,
    };
  }
  if (command !== "compile") {
    throw new Error(
      "Usage: doctor | compile --input <artifact-id-manifest.json> [--output <report.json>]",
    );
  }
  const inputOption = argValue(args, "--input");
  if (!inputOption) {
    throw new Error("Motion calibration compile requires --input.");
  }
  const bundle = readBundle(resolve(ROOT, inputOption));
  const contentArtifactRepository = dependencies.contentArtifactRepository
    || localContentArtifactRepository();
  const resolver = dependencies.motionCalibrationCaseFromArtifacts
    || motionCalibrationCaseFromArtifacts;
  const reportBuilder = dependencies.buildMotionCalibrationCorpusReport
    || buildMotionCalibrationCorpusReport;
  const cases = await resolveCases(
    bundle.cases,
    contentArtifactRepository,
    resolver,
  );
  const report = reportBuilder({ cases });
  const outputOption = argValue(args, "--output");
  if (outputOption) writeReport(resolve(ROOT, outputOption), report);
  return {
    mode: "compiled",
    outputWritten: Boolean(outputOption),
    report,
  };
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCli()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${String(
        error?.message || "Motion calibration failed safely.",
      ).slice(0, 240)}\n`);
      process.exitCode = 1;
    });
}
