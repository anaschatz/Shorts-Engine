#!/usr/bin/env node
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { alignerDoctor } = require("../server/pipelines/narrated-short/pilot/operator-tools.cjs");
try { process.stdout.write(`${JSON.stringify(alignerDoctor(), null, 2)}\n`); } catch { process.stderr.write(`${JSON.stringify({ status: "runtime_failed", nextActions: ["inspect-local-runtime"] })}\n`); process.exitCode = 1; }
