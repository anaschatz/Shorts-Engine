#!/usr/bin/env node

import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";

import { CALIBRATION_ROOT } from "./render-generalized-visual-calibration-pack.mjs";

const require = createRequire(import.meta.url);
const {
  aggregateHumanCalibration,
  normalizeHumanCalibrationAssignment,
  normalizeHumanCalibrationResponse,
} = require("../server/pipelines/narrated-short/animation/generalized-visual-human-calibration-contract.cjs");

const PACK_RE = /^calibration_[a-f0-9]{24}$/;

export function parseGeneralizedVisualCalibrationFinalizeArguments(argv) {
  if (argv.length !== 3 || argv[0] !== "--pack" || !PACK_RE.test(argv[1]) || argv[2] !== "--confirm-human-responses") {
    throw new TypeError("Use --pack calibration_<24 hex> --confirm-human-responses.");
  }
  return Object.freeze({ packId: argv[1], reviewerFinalConfirmation: true });
}

export async function finalizeGeneralizedVisualCalibration({ packId, root = CALIBRATION_ROOT } = {}) {
  if (!PACK_RE.test(packId || "") || typeof root !== "string") throw new TypeError("Calibration finalize input is invalid.");
  const directory = join(root, packId);
  const assignment = normalizeHumanCalibrationAssignment(JSON.parse(await readFile(join(directory, "assignment.json"), "utf8")));
  if (assignment.calibrationId !== packId) throw new TypeError("Calibration finalize binding is invalid.");
  const responseNames = (await readdir(join(directory, "responses"))).filter((name) => /^response_[a-f0-9]{24}\.json$/.test(name)).sort();
  const responses = [];
  for (const name of responseNames) responses.push(normalizeHumanCalibrationResponse(JSON.parse(await readFile(join(directory, "responses", name), "utf8")), assignment));
  const result = aggregateHumanCalibration({ assignment, responses, reviewerFinalConfirmation: true });
  const destination = join(directory, "calibration-result.json");
  const temporary = `${destination}.next`;
  await writeFile(temporary, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
  return result;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    const args = parseGeneralizedVisualCalibrationFinalizeArguments(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(await finalizeGeneralizedVisualCalibration(args))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: "GENERALIZED_VISUAL_CALIBRATION_FINALIZE_FAILED", reason: error instanceof TypeError || error?.code === "ENOENT" ? error.message : "finalize_failed" })}\n`);
    process.exitCode = 1;
  }
}
