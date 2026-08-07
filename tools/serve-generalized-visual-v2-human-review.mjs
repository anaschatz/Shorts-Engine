#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";

import { HUMAN_REVIEW_ROOT } from "./lib/generalized-visual-v2-human-review-pack.mjs";

const require = createRequire(import.meta.url);
const {
  createHumanReviewResponse,
  normalizeHumanReviewAssignment,
} = require("../server/pipelines/narrated-short/animation/generalized-visual-v2-human-review-contract.cjs");

const REVIEW_RE = /^review_[a-f0-9]{24}$/;
const MEDIA_RE = /^\/media\/media_[a-f0-9]{24}\.mp4$/;
const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; media-src 'self'; img-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

export function parseGeneralizedVisualV2HumanReviewServerArguments(argv = []) {
  if (argv.length < 2 || argv[0] !== "--review" || !REVIEW_RE.test(argv[1])) {
    throw new TypeError("Use --review review_<24 hex> [--port 4174].");
  }
  let port = 4174;
  if (argv.length === 4 && argv[2] === "--port") port = Number(argv[3]);
  else if (argv.length !== 2) throw new TypeError("Use --review review_<24 hex> [--port 4174].");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new TypeError("Human review port is invalid.");
  }
  return Object.freeze({ reviewId: argv[1], port });
}

function respond(response, status, body, headers = {}, method = "GET") {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Length": buffer.byteLength,
    ...headers,
  });
  if (method === "HEAD") response.end();
  else response.end(buffer);
}

async function jsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new TypeError("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseRange(header, length) {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!match) throw new TypeError("invalid_range");
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : length - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= length) {
    throw new TypeError("invalid_range");
  }
  return { start, end: Math.min(end, length - 1) };
}

async function serveMedia(request, response, directory, pathname) {
  const bytes = await readFile(join(directory, pathname.slice(1)));
  let range;
  try {
    range = parseRange(request.headers.range, bytes.byteLength);
  } catch {
    return respond(response, 416, "Range not satisfiable\n", {
      "Content-Range": `bytes */${bytes.byteLength}`,
      "Content-Type": "text/plain; charset=utf-8",
    }, request.method);
  }
  if (!range) {
    return respond(response, 200, bytes, {
      "Accept-Ranges": "bytes",
      "Content-Type": "video/mp4",
    }, request.method);
  }
  const body = bytes.subarray(range.start, range.end + 1);
  return respond(response, 206, body, {
    "Accept-Ranges": "bytes",
    "Content-Range": `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
    "Content-Type": "video/mp4",
  }, request.method);
}

export async function createGeneralizedVisualV2HumanReviewServer({
  reviewId,
  port = 4174,
  root = HUMAN_REVIEW_ROOT,
} = {}) {
  if (!REVIEW_RE.test(reviewId || "") || !Number.isInteger(port) || port < 0 || port > 65535 || typeof root !== "string") {
    throw new TypeError("Human review server input is invalid.");
  }
  const directory = join(root, reviewId);
  const assignment = normalizeHumanReviewAssignment(JSON.parse(await readFile(join(directory, "assignment.json"), "utf8")));
  if (assignment.reviewId !== reviewId) throw new TypeError("Human review pack binding is invalid.");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/api/responses") {
        if (
          request.headers["x-human-review-assignment"] !== assignment.contentHash
          || request.headers["content-type"] !== "application/json"
        ) return respond(response, 403, '{"error":"forbidden"}\n', { "Content-Type": "application/json; charset=utf-8" });
        const created = createHumanReviewResponse(await jsonBody(request), assignment);
        try {
          await writeFile(
            join(directory, "responses", `${created.responseId}.json`),
            `${JSON.stringify(created)}\n`,
            { flag: "wx", mode: 0o600 },
          );
        } catch (error) {
          if (error?.code === "EEXIST") {
            return respond(response, 409, '{"error":"duplicate_response"}\n', { "Content-Type": "application/json; charset=utf-8" });
          }
          throw error;
        }
        return respond(response, 201, `${JSON.stringify({ saved: true, responseId: created.responseId })}\n`, {
          "Content-Type": "application/json; charset=utf-8",
        });
      }
      if (!["GET", "HEAD"].includes(request.method)) {
        return respond(response, 405, "Method not allowed\n", { "Content-Type": "text/plain; charset=utf-8" }, request.method);
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const body = await readFile(join(directory, "index.html"));
        return respond(response, 200, body, { "Content-Type": "text/html; charset=utf-8" }, request.method);
      }
      if (MEDIA_RE.test(url.pathname)) return await serveMedia(request, response, directory, url.pathname);
      return respond(response, 404, "Not found\n", { "Content-Type": "text/plain; charset=utf-8" }, request.method);
    } catch (error) {
      const status = error?.code === "ENOENT"
        ? 404
        : error?.message === "request_too_large"
          ? 413
          : error instanceof SyntaxError || error instanceof TypeError
            ? 400
            : 500;
      return respond(response, status, `${JSON.stringify({ error: status === 500 ? "internal_error" : "invalid_request" })}\n`, {
        "Content-Type": "application/json; charset=utf-8",
      });
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const activePort = typeof address === "object" && address ? address.port : port;
  return Object.freeze({ server, reviewId, port: activePort, url: `http://127.0.0.1:${activePort}/` });
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    const active = await createGeneralizedVisualV2HumanReviewServer(
      parseGeneralizedVisualV2HumanReviewServerArguments(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify({
      reviewId: active.reviewId,
      url: active.url,
      humanReviewStatus: "pending",
      requiredReviewerCount: 5,
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      error: "GENERALIZED_VISUAL_V2_HUMAN_REVIEW_SERVER_FAILED",
      reason: error instanceof TypeError || error?.code === "ENOENT" ? error.message : "human_review_server_failed",
    })}\n`);
    process.exitCode = 1;
  }
}
