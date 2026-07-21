#!/usr/bin/env node
// Ports Fitting probe — verifies the server module loads and a port can bind.
// Prints "ok" + exits 0 on success. This is the runner's verify-hook surface.

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
    await import("./server.mjs");
  } catch (err) {
    console.error(`probe: failed to import server.mjs — ${err.message}`);
    process.exit(1);
  }
  // Core module must load and expose its pure functions.
  try {
    const core = await import("../lib/ports-core.mjs");
    for (const fn of ["parseSs", "buildPortRows", "killGuard"]) {
      if (typeof core[fn] !== "function") {
        console.error(`probe: ports-core.mjs missing ${fn}`);
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(`probe: failed to import ports-core.mjs — ${err.message}`);
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
