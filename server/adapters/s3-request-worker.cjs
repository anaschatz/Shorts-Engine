const http = require("node:http");
const https = require("node:https");
const { createReadStream, createWriteStream, statSync, unlinkSync } = require("node:fs");

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function requestOnce(input) {
  return new Promise((resolve, reject) => {
    const url = new URL(input.url);
    const transport = url.protocol === "http:" ? http : https;
    const body = input.bodyBase64 ? Buffer.from(input.bodyBase64, "base64") : Buffer.alloc(0);
    const req = transport.request(
      url,
      {
        method: input.method,
        headers: input.headers || {},
        timeout: Number(input.timeoutMs || 30_000),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("error", reject);
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers || {},
            bodyBase64: Buffer.concat(chunks).toString("base64"),
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", reject);
    if (body.length) req.write(body);
    req.end();
  });
}

function requestDownloadToFile(input) {
  return new Promise((resolve, reject) => {
    const url = new URL(input.url);
    const transport = url.protocol === "http:" ? http : https;
    let bytes = 0;
    const req = transport.request(
      url,
      {
        method: input.method || "GET",
        headers: input.headers || {},
        timeout: Number(input.timeoutMs || 30_000),
      },
      (res) => {
        const file = createWriteStream(input.filePath);
        res.on("data", (chunk) => {
          bytes += chunk.length;
        });
        res.on("error", reject);
        file.on("error", reject);
        file.on("finish", () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers || {},
            bytes,
          });
        });
        res.pipe(file);
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", (error) => {
      try {
        unlinkSync(input.filePath);
      } catch {
        // Best-effort failed download cleanup.
      }
      reject(error);
    });
    req.end();
  });
}

function requestUploadFromFile(input) {
  return new Promise((resolve, reject) => {
    const url = new URL(input.url);
    const transport = url.protocol === "http:" ? http : https;
    const fileStat = statSync(input.filePath);
    const req = transport.request(
      url,
      {
        method: input.method || "PUT",
        headers: {
          ...(input.headers || {}),
          "content-length": String(fileStat.size),
        },
        timeout: Number(input.timeoutMs || 30_000),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("error", reject);
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers || {},
            bytes: fileStat.size,
            bodyBase64: Buffer.concat(chunks).toString("base64"),
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", reject);
    createReadStream(input.filePath).on("error", reject).pipe(req);
  });
}

async function main() {
  const raw = await readStdin();
  const input = JSON.parse(raw || "{}");
  let result;
  if (input.operation === "downloadToFile") {
    result = await requestDownloadToFile(input);
  } else if (input.operation === "uploadFromFile") {
    result = await requestUploadFromFile(input);
  } else {
    result = await requestOnce(input);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.message ? error.message : "request failed"}\n`);
  process.exitCode = 1;
});
