import test, { before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  BRAIN_ROOT,
  findContext,
  health,
  initBrain,
  printTree,
  scoreText,
  sessionAdd,
  sessionCommit,
  tokenize,
} from "../tools/openviking-lite.mjs";

let initResult;

before(() => {
  initResult = initBrain({ refresh: true });
});

test("tokenization supports English and Greek terms", () => {
  const tokens = tokenize("AI highlights με υπότιτλους και safe exports");
  assert.ok(tokens.includes("ai"));
  assert.ok(tokens.includes("highlights"));
  assert.ok(tokens.includes("υπότιτλους"));
  assert.ok(tokens.includes("safe"));
});

test("scoreText ranks matching text above unrelated text", () => {
  const query = tokenize("upload validation idempotency");
  assert.ok(scoreText(query, "upload validation and idempotency keys") > scoreText(query, "visual hero layout"));
});

test("init creates required OpenViking-style brain layers", () => {
  assert.equal(existsSync(BRAIN_ROOT), true);
  assert.ok(initResult.files > 20);
  assert.equal(health().ok, true);
});

test("tree exposes resources, memories, skills, sessions and trajectories", () => {
  const tree = printTree(BRAIN_ROOT, 3).join("\n");
  assert.match(tree, /resources\//);
  assert.match(tree, /memories\//);
  assert.match(tree, /skills\//);
  assert.match(tree, /sessions\//);
  assert.match(tree, /trajectories\//);
});

test("recursive retrieval returns relevant resources and writes trajectory files", () => {
  const result = findContext("upload validation idempotency export jobs", { limit: 5 });
  assert.ok(result.results.length > 0);
  assert.match(result.results[0].uri, /matchcuts|agent/);
  assert.equal(existsSync(result.trajectory.json), true);
  assert.equal(existsSync(result.trajectory.html), true);

  const trace = JSON.parse(readFileSync(result.trajectory.json, "utf8"));
  assert.equal(trace.query, "upload validation idempotency export jobs");
  assert.ok(trace.nodes.some((node) => node.type === "directory"));
  assert.ok(trace.nodes.some((node) => node.type === "file"));
});

test("session add and commit creates durable agent memory", () => {
  sessionAdd({
    sessionId: "test-openviking-lite",
    role: "user",
    text: "We hardened app.js and hardening.js with upload validation and safe job states.",
  });
  sessionAdd({
    sessionId: "test-openviking-lite",
    role: "assistant",
    text: "Remember to inspect viking-brain/trajectories when retrieval quality is poor.",
  });
  const committed = sessionCommit("test-openviking-lite");
  assert.equal(existsSync(committed.target), true);
  const memory = readFileSync(committed.target, "utf8");
  assert.match(memory, /upload validation/);
  assert.match(memory, /viking-brain\/trajectories/);
});
