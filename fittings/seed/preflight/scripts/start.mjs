#!/usr/bin/env node
// Entrypoint shim — the runner spawns scripts/start.mjs by convention
// (own-port-lifecycle). All real logic lives in server.mjs.

import { startServer } from "./server.mjs";

startServer()
  .then((server) => {
    // Warm the report so the first tab does not pay the full collector run:
    // with the cache primed, every later read is served at once and refreshed
    // behind the response. Lives here, not in startServer(), so tests that
    // count buildReport calls see exactly the reads they make.
    const bound = server.address();
    if (bound && typeof bound === "object" && bound.port) {
      const host = bound.address === "::" || bound.address === "0.0.0.0" ? "127.0.0.1" : bound.address;
      fetch(`http://${host}:${bound.port}/api/report`).then((r) => r.arrayBuffer()).catch(() => {});
    }
  })
  .catch((err) => {
    console.error("[preflight] fatal:", err?.message ?? err);
    process.exit(1);
  });
