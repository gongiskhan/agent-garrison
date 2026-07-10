#!/usr/bin/env node
// Power Fitting probe — verifies the server + core modules load and a port can
// be bound. Prints "ok" + exits 0 on success (the verify-hook surface).

import http from "node:http";

const args = process.argv.slice(2);
if (!args.includes("--probe")) {
  console.error("usage: probe.mjs --probe");
  process.exit(2);
}

async function canBind() {
  return new Promise((resolve) => {
    const srv = http.createServer(() => {});
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(0, "127.0.0.1");
  });
}

async function main() {
  try {
    await import("./server.mjs");
    await import("../lib/power-core.mjs");
    await import("../lib/gcp-suspend.mjs");
  } catch (err) {
    console.error(`probe: module load failed — ${err.message}`);
    process.exit(1);
  }
  if (!(await canBind())) {
    console.error("probe: cannot bind ephemeral port on 127.0.0.1");
    process.exit(1);
  }
  console.log("ok");
  process.exit(0);
}

main().catch((err) => {
  console.error("probe:", err.message);
  process.exit(1);
});
