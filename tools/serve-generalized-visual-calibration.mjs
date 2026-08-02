#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, extname, join, normalize, sep } from "node:path";
import { createRequire } from "node:module";

import { CALIBRATION_ROOT } from "./render-generalized-visual-calibration-pack.mjs";

const require = createRequire(import.meta.url);
const {
  aggregateHumanCalibration,
  createHumanCalibrationResponse,
  normalizeHumanCalibrationAssignment,
  normalizeHumanCalibrationResponse,
} = require("../server/pipelines/narrated-short/animation/generalized-visual-human-calibration-contract.cjs");

const PACK_RE = /^calibration_[a-f0-9]{24}$/;
const MIME = new Map([[".html", "text/html; charset=utf-8"], [".json", "application/json; charset=utf-8"]]);
const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; img-src 'none'; media-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
});

function parseArguments(argv) {
  if (argv.length < 2 || argv[0] !== "--pack" || !PACK_RE.test(argv[1])) throw new TypeError("Use --pack calibration_<24 hex> [--port 4173].");
  let port = 4173;
  if (argv.length === 4 && argv[2] === "--port") port = Number(argv[3]);
  else if (argv.length !== 2) throw new TypeError("Use --pack calibration_<24 hex> [--port 4173].");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new TypeError("Calibration port is invalid.");
  return { packId: argv[1], port };
}

function respond(response, status, body, headers = {}) {
  response.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  response.end(body);
}

async function jsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32768) throw new TypeError("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function loadResponses(directory, assignment) {
  const names = (await readdir(join(directory, "responses"))).filter((name) => /^response_[a-f0-9]{24}\.json$/.test(name)).sort();
  const responses = [];
  for (const name of names) responses.push(normalizeHumanCalibrationResponse(JSON.parse(await readFile(join(directory, "responses", name), "utf8")), assignment));
  return responses;
}

async function atomicJson(path, value) {
  const temporary = `${path}.next`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function createGeneralizedVisualCalibrationServer({ packId, port = 4173 } = {}) {
  if (!PACK_RE.test(packId || "")) throw new TypeError("Calibration pack ID is invalid.");
  const directory = join(CALIBRATION_ROOT, packId);
  const assignment = normalizeHumanCalibrationAssignment(JSON.parse(await readFile(join(directory, "assignment.json"), "utf8")));
  if (assignment.calibrationId !== packId) throw new TypeError("Calibration pack binding is invalid.");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/api/responses") {
        if (request.headers["x-calibration-assignment"] !== assignment.contentHash || request.headers["content-type"] !== "application/json") return respond(response, 403, '{"error":"forbidden"}\n', { "Content-Type": MIME.get(".json") });
        const raw = await jsonBody(request);
        const created = createHumanCalibrationResponse(raw, assignment);
        try {
          await writeFile(join(directory, "responses", `${created.responseId}.json`), `${JSON.stringify(created)}\n`, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if (error?.code === "EEXIST") return respond(response, 409, '{"error":"duplicate_response"}\n', { "Content-Type": MIME.get(".json") });
          throw error;
        }
        return respond(response, 201, `${JSON.stringify({ saved: true, responseId: created.responseId })}\n`, { "Content-Type": MIME.get(".json") });
      }
      if (request.method === "POST" && url.pathname === "/api/finalize") {
        if (request.headers["x-calibration-assignment"] !== assignment.contentHash || request.headers["content-type"] !== "application/json") return respond(response, 403, '{"error":"forbidden"}\n', { "Content-Type": MIME.get(".json") });
        const raw = await jsonBody(request);
        const reviewerFinalConfirmation = raw && Object.keys(raw).length === 1 && raw.reviewerFinalConfirmation === true;
        if (!reviewerFinalConfirmation) return respond(response, 400, '{"error":"explicit_confirmation_required"}\n', { "Content-Type": MIME.get(".json") });
        const result = aggregateHumanCalibration({ assignment, responses: await loadResponses(directory, assignment), reviewerFinalConfirmation });
        await atomicJson(join(directory, "calibration-result.json"), result);
        return respond(response, 200, `${JSON.stringify(result)}\n`, { "Content-Type": MIME.get(".json") });
      }
      if (request.method !== "GET") return respond(response, 405, "Method not allowed\n", { "Content-Type": "text/plain; charset=utf-8" });
      const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const safe = normalize(requested);
      if (safe.startsWith(`..${sep}`) || safe.includes(`${sep}..${sep}`) || basename(safe) !== safe && !safe.startsWith(`previews${sep}`)) return respond(response, 404, "Not found\n", { "Content-Type": "text/plain; charset=utf-8" });
      if (!/^(?:index\.html|previews[\\/][a-z0-9_-]{3,96}\.html)$/.test(safe)) return respond(response, 404, "Not found\n", { "Content-Type": "text/plain; charset=utf-8" });
      const body = await readFile(join(directory, safe));
      return respond(response, 200, body, { "Content-Type": MIME.get(extname(safe)) || "application/octet-stream" });
    } catch (error) {
      const status = error?.code === "ENOENT" ? 404 : error?.message === "request_too_large" ? 413 : error instanceof SyntaxError || error instanceof TypeError ? 400 : 500;
      return respond(response, status, `${JSON.stringify({ error: status === 500 ? "internal_error" : "invalid_request" })}\n`, { "Content-Type": MIME.get(".json") });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return Object.freeze({ server, packId, port, url: `http://127.0.0.1:${port}/` });
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const active = await createGeneralizedVisualCalibrationServer(args);
    process.stdout.write(`${JSON.stringify({ packId: active.packId, url: active.url, humanReviewStatus: "pending" })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: "GENERALIZED_VISUAL_CALIBRATION_SERVER_FAILED", reason: error instanceof TypeError || error?.code === "ENOENT" ? error.message : "server_start_failed" })}\n`);
    process.exitCode = 1;
  }
}
