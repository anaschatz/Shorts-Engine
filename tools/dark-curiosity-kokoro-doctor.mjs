#!/usr/bin/env node
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { doctor } = require("../server/pipelines/narrated-short/narration/tts/kokoro-runtime.cjs");
const result = doctor(); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); process.exitCode = result.status === "ready" ? 0 : 1;
