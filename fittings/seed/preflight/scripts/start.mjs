#!/usr/bin/env node
// Entrypoint shim — the runner spawns scripts/start.mjs by convention
// (own-port-lifecycle). All real logic lives in server.mjs.

import { startServer } from "./server.mjs";

startServer().catch((err) => {
  console.error("[preflight] fatal:", err?.message ?? err);
  process.exit(1);
});
