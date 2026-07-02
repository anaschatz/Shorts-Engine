import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { findSensitiveLeak } from "../../demo/report-safety.mjs";

const require = createRequire(import.meta.url);

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOL_CONTRACTS = Object.freeze([
  {
    id: "ruflo",
    displayName: "Ruflo",
    repoRelativePath: "ruflo",
    expectedRemote: "https://github.com/ruvnet/ruflo.git",
    requiredFiles: ["README.md", "package.json", "LICENSE"],
    command: "ruflo",
    packageManagerHint: "npx ruflo@latest --help",
    usage: "Optional agent workflow and harness reference for planning/review gates.",
  },
  {
    id: "graphify",
    displayName: "Graphify",
    repoRelativePath: "graphify",
    expectedRemote: "https://github.com/safishamsi/graphify.git",
    requiredFiles: ["README.md", "pyproject.toml", "LICENSE"],
    command: "graphify",
    packageManagerHint: "uvx --from graphifyy graphify --help",
    usage: "Optional knowledge graph tooling for codebase maps and architecture queries.",
  },
]);

function safeRelativePath(relativePath) {
  const resolved = resolve(ROOT_DIR, relativePath);
  const fromRoot = relative(ROOT_DIR, resolved);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot) || fromRoot.includes("\\")) {
    throw new Error("AGENT_TOOL_PATH_UNSAFE");
  }
  return fromRoot;
}

function readJson(relativePath) {
  const safePath = safeRelativePath(relativePath);
  return JSON.parse(readFileSync(resolve(ROOT_DIR, safePath), "utf8"));
}

function readText(relativePath) {
  const safePath = safeRelativePath(relativePath);
  return readFileSync(resolve(ROOT_DIR, safePath), "utf8");
}

function commandAvailable(command) {
  const result = spawnSync(command, ["--version"], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  return result.status === 0 || result.status === 1;
}

function gitRemoteMatches(repoRelativePath, expectedRemote) {
  const safeRepoPath = safeRelativePath(repoRelativePath);
  const result = spawnSync("git", ["-C", safeRepoPath, "remote", "get-url", "origin"], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  if (result.status !== 0) {
    return { checked: false, matches: false };
  }
  return { checked: true, matches: String(result.stdout || "").trim() === expectedRemote };
}

function detectLicense(relativePath) {
  const text = readText(`${relativePath}/LICENSE`);
  if (/MIT License/i.test(text)) return "MIT";
  return "unknown";
}

function inspectTool(contract) {
  const repoPath = safeRelativePath(contract.repoRelativePath);
  const absoluteRepoPath = resolve(ROOT_DIR, repoPath);
  const exists = existsSync(absoluteRepoPath);
  const requiredFiles = contract.requiredFiles.map((fileName) => {
    const relativeFilePath = `${repoPath}/${fileName}`;
    return {
      file: relativeFilePath,
      present: existsSync(resolve(ROOT_DIR, safeRelativePath(relativeFilePath))),
    };
  });
  const missingFiles = requiredFiles.filter((file) => !file.present).map((file) => file.file);
  const remote = exists ? gitRemoteMatches(repoPath, contract.expectedRemote) : { checked: false, matches: false };
  const packageInfo =
    contract.id === "ruflo" && exists && missingFiles.length === 0
      ? (() => {
          const pkg = readJson(`${repoPath}/package.json`);
          return {
            name: typeof pkg.name === "string" ? pkg.name : "unknown",
            version: typeof pkg.version === "string" ? pkg.version : "unknown",
            engines: pkg.engines && typeof pkg.engines.node === "string" ? { node: pkg.engines.node } : undefined,
          };
        })()
      : undefined;
  const pythonInfo =
    contract.id === "graphify" && exists && missingFiles.length === 0
      ? (() => {
          const pyproject = readText(`${repoPath}/pyproject.toml`);
          const name = pyproject.match(/^name\s*=\s*"([^"]+)"/m)?.[1] || "unknown";
          const version = pyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1] || "unknown";
          const requiresPython = pyproject.match(/^requires-python\s*=\s*"([^"]+)"/m)?.[1] || "unknown";
          return { name, version, requiresPython };
        })()
      : undefined;
  const license = exists && missingFiles.length === 0 ? detectLicense(repoPath) : "unknown";
  const cliAvailable = commandAvailable(contract.command);
  const usable = exists && remote.matches && missingFiles.length === 0 && license !== "unknown";

  return {
    id: contract.id,
    displayName: contract.displayName,
    status: usable ? "ready" : "not_ready",
    repo: {
      relativePath: repoPath,
      present: exists,
      remote: remote.checked ? (remote.matches ? "expected" : "unexpected") : "not_checked",
    },
    requiredFiles,
    license,
    package: packageInfo,
    pythonPackage: pythonInfo,
    cli: {
      command: contract.command,
      installedOnPath: cliAvailable,
      optional: true,
      installHint: contract.packageManagerHint,
    },
    usage: contract.usage,
    nextAction: usable
      ? "Use as optional local reference/tooling; install CLI only with explicit operator approval."
      : `Restore or clone ${contract.expectedRemote} into ${repoPath}.`,
  };
}

function assertSafeReport(report) {
  const leak = findSensitiveLeak(report);
  if (leak) {
    throw new Error(`AGENT_TOOL_REPORT_UNSAFE:${leak.path || leak.reason || "unknown"}`);
  }
}

export function buildAgentToolingReport() {
  const tools = TOOL_CONTRACTS.map(inspectTool);
  const missing = tools.filter((tool) => tool.status !== "ready").map((tool) => tool.id);
  const report = {
    schemaVersion: 1,
    command: "npm run agent:tools:doctor",
    phase: "agent_tooling_readiness",
    status: missing.length === 0 ? "ready" : "degraded",
    passed: missing.length === 0,
    skipped: false,
    tools,
    safety: {
      networkRequired: false,
      installsPerformed: false,
      repoMutationsPerformed: false,
      sensitiveInputsRequired: false,
      reportsGenerated: false,
      logDownloads: false,
      safeReferencesOnly: true,
    },
    nextAction:
      missing.length === 0
        ? "Run optional graph/workflow tooling only with explicit operator intent."
        : `Fix missing tools: ${missing.join(", ")}.`,
  };
  assertSafeReport(report);
  return report;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] || "")) {
  try {
    const report = buildAgentToolingReport();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(report.passed ? 0 : 1);
  } catch (error) {
    const safeFailure = {
      schemaVersion: 1,
      command: "npm run agent:tools:doctor",
      phase: "agent_tooling_readiness",
      status: "failed",
      passed: false,
      skipped: false,
      code: error && typeof error.message === "string" ? error.message.split(":")[0] : "AGENT_TOOLING_FAILED",
      nextAction: "Inspect local tool check implementation without exposing raw command output.",
    };
    process.stdout.write(`${JSON.stringify(safeFailure, null, 2)}\n`);
    process.exit(1);
  }
}
