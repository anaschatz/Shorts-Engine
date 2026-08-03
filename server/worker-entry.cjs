const { createRuntime } = require("./runtime/create-runtime.cjs");

async function main() {
  const runtime = await createRuntime();
  if (runtime.role !== "worker") {
    throw new Error("worker-entry requires SHORTSENGINE_PROCESS_ROLE=worker");
  }
  await runtime.start();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await runtime.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      level: "error",
      event: "production_worker_start_failed",
      code: error && error.code || "UNEXPECTED",
    }));
    process.exitCode = 1;
  });
}

module.exports = { main };
