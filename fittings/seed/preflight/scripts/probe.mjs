#!/usr/bin/env node
// Preflight probe — the runner's verify-hook surface. Verifies the server and
// core modules load, the pure API is intact, and a port can bind. Prints "ok"
// + exits 0 on success (ports-default pattern).

import http from "node:http";

const args = process.argv.slice(2);
if (!args.includes("--probe")) {
  console.error("usage: probe.mjs --probe");
  process.exit(2);
}

function canBind() {
  return new Promise((resolve) => {
    const srv = http.createServer(() => {});
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(0, "127.0.0.1");
  });
}

async function main() {
  try {
    const server = await import("./server.mjs");
    if (typeof server.startServer !== "function") {
      console.error("probe: server.mjs missing startServer");
      process.exit(1);
    }
  } catch (err) {
    console.error(`probe: failed to import server.mjs — ${err.message}`);
    process.exit(1);
  }
  try {
    const core = await import("../lib/preflight-core.mjs");
    for (const fn of [
      "parseManifest", "parseComposition", "crossCheckLibrary", "buildPortClaims",
      "findPortCollisions", "assessVerifyResults", "assessSweepResults",
      "serveCoverage", "classifyOrphans", "assessDrift", "scanKinds", "summarize"
    ]) {
      if (typeof core[fn] !== "function") {
        console.error(`probe: preflight-core.mjs missing ${fn}`);
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(`probe: failed to import preflight-core.mjs — ${err.message}`);
    process.exit(1);
  }
  try {
    const fixers = await import("../lib/fixers.mjs");
    if (typeof fixers.runFix !== "function") {
      console.error("probe: fixers.mjs missing runFix");
      process.exit(1);
    }
  } catch (err) {
    console.error(`probe: failed to import fixers.mjs — ${err.message}`);
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
