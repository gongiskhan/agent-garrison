#!/usr/bin/env node
// Monitor Fitting probe — verifies the server module loads and can bind a port.
// Prints "ok" + exits 0 on success.

import http from "node:http";

const args = process.argv.slice(2);
const isProbe = args.includes("--probe");
if (!isProbe) {
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
  // Module load smoke
  try {
    await import("./server.mjs");
  } catch (err) {
    console.error(`probe: failed to import server.mjs — ${err.message}`);
    process.exit(1);
  }
  const ok = await canBind();
  if (!ok) {
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
