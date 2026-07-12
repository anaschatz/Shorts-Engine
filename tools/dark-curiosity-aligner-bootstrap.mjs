#!/usr/bin/env node
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parseBootstrapArgs, runBootstrap } = require("../server/pipelines/narrated-short/pilot/bootstrap.cjs");
const HELP = `Usage: npm run dark-curiosity:aligner:bootstrap -- [--dry-run] [--install-package] [--download-model] [--model tiny|base|small] [--device cpu] [--compute-type int8] [--timeout-ms N] [--yes]\nDefault is a no-mutation dry run. Install/download flags also require --yes.\n`;
try { const options = parseBootstrapArgs(process.argv.slice(2)); if (options.help) process.stdout.write(HELP); else process.stdout.write(`${JSON.stringify(runBootstrap(options), null, 2)}\n`); } catch (error) { process.stderr.write(`${JSON.stringify({ status: "failed", code: String(error && error.code || "ALIGNER_BOOTSTRAP_FAILED").replace(/[^A-Z0-9_]/g, "_").slice(0, 80), nextAction: error && error.details && error.details.nextAction || "inspect-bootstrap-authorization" })}\n`); process.exitCode = 1; }
