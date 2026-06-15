import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manualPath = resolve(ROOT_DIR, "demo", "MANUAL_TESTING.md");

console.log(readFileSync(manualPath, "utf8"));
