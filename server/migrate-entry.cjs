const { createRuntime } = require("./runtime/create-runtime.cjs");

async function main() {
  const runtime = await createRuntime();
  if (runtime.role !== "migrate") {
    throw new Error("migrate-entry requires SHORTSENGINE_PROCESS_ROLE=migrate");
  }
  try {
    await runtime.start();
  } finally {
    await runtime.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      level: "error",
      event: "production_migration_failed",
      code: error && error.code || "DB_MIGRATION_FAILED",
    }));
    process.exitCode = 1;
  });
}

module.exports = { main };
