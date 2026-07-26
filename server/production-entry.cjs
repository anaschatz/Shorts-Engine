const { createServer } = require("node:http");
const { createRuntime } = require("./runtime/create-runtime.cjs");
const { createProductionWebApp } = require("./web/production-web-app.cjs");

async function main() {
  const runtime = await createRuntime();
  let server = null;
  try {
    if (runtime.role !== "web") {
      throw new Error("production-entry requires SHORTSENGINE_PROCESS_ROLE=web");
    }
    await runtime.start();
    const handler = createProductionWebApp({ runtime });
    server = createServer(handler);
    const port = Number(process.env.PORT || 3000);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", resolve);
    });
  } catch (error) {
    await runtime.close().catch(() => {});
    throw error;
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await new Promise((resolve) => server.close(resolve));
    await runtime.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      level: "error",
      event: "production_web_start_failed",
      code: error && error.code || "UNEXPECTED",
    }));
    process.exitCode = 1;
  });
}

module.exports = { main };
