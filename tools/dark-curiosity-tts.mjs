#!/usr/bin/env node
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { inspectTtsNarration, synthesizeTtsNarration, verifyTtsNarration } = require("../server/pipelines/narrated-short/narration/tts/service.cjs");

const valueFlags = new Set(["--fixture", "--project", "--provider", "--voice", "--model", "--speaking-rate", "--pacing-profile", "--terms-reference", "--attested-by"]);
const booleanFlags = new Set(["--commercial-use-attested", "--regenerate", "--dry-run", "--json", "--help", "--voice-cloned", "--impersonated"]);
function invalid(field) { const error = new Error("Invalid TTS arguments."); error.code = "VALIDATION_ERROR"; error.field = field; throw error; }
function parse(argv) {
  const command = argv.shift(); if (!["synthesize", "inspect", "verify"].includes(command)) invalid("command"); const values = {};
  for (let i = 0; i < argv.length; i += 1) { const key = argv[i]; if (booleanFlags.has(key)) { if (values[key]) invalid(key); values[key] = true; continue; } if (!valueFlags.has(key)) invalid(key); const value = argv[++i]; if (!value || value.startsWith("--")) invalid(key); values[key] = value; }
  if (values["--help"]) return { help: true };
  if (!values["--project"]) invalid("project");
  if (["synthesize", "verify"].includes(command) && !values["--fixture"]) invalid("fixture");
  const provider = values["--provider"] || process.env.SHORTSENGINE_TTS_PROVIDER || "kokoro_local"; const voiceId = values["--voice"] || process.env.SHORTSENGINE_TTS_VOICE || (provider === "kokoro_local" ? "af_heart" : "coral"); const model = values["--model"] || process.env.SHORTSENGINE_TTS_MODEL || undefined;
  if (command === "synthesize" && (!provider || !voiceId)) invalid("provider-or-voice");
  return { command, projectDir: values["--project"], fixture: values["--fixture"], provider, voiceId, model, speakingRate: values["--speaking-rate"] || 1, pacingProfile: values["--pacing-profile"], termsReference: values["--terms-reference"], attestedBy: values["--attested-by"], commercialUseAttested: values["--commercial-use-attested"] === true, regenerate: values["--regenerate"] === true, dryRun: values["--dry-run"] === true, voiceCloned: values["--voice-cloned"] === true, impersonated: values["--impersonated"] === true };
}
const HELP = `Commands:\n  synthesize --fixture <approved.json> --project <dir> --provider <kokoro_local|openai|mock> --voice <id> [--pacing-profile <dark_curiosity_comprehension_v1|none>] [--commercial-use-attested] [--regenerate] [--dry-run]\n  inspect --project <dir>\n  verify --fixture <approved.json> --project <dir>\n`;
function safeFailure(error) { const code = String(error && error.code || "TTS_FAILED").replace(/[^A-Z0-9_]/g, "_").slice(0, 80); const details = error && error.details && Array.isArray(error.details.missingEnvironmentVariables) ? { missingEnvironmentVariables: error.details.missingEnvironmentVariables } : {}; return { status: "failed", code, ...details }; }
try { const options = parse(process.argv.slice(2)); if (options.help) process.stdout.write(HELP); else { const result = options.command === "synthesize" ? await synthesizeTtsNarration(options) : options.command === "verify" ? await verifyTtsNarration(options) : inspectTtsNarration(options.projectDir); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); if (["verify", "inspect"].includes(options.command) && !result.valid) process.exitCode = 2; } } catch (error) { process.stderr.write(`${JSON.stringify(safeFailure(error))}\n`); process.exitCode = error && error.code === "TTS_CREDENTIALS_MISSING" ? 3 : error && /TAMPERED|MISMATCH/.test(error.code || "") ? 4 : 1; }
