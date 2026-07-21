#!/usr/bin/env node
// Drill own-port entrypoint — spawned by Garrison's runner during composition
// `up` (startOwnPortFitting), by eager boot, and by /api/fittings/drill/start.
import { startServer } from "./server.mjs";

startServer().catch((err) => {
  console.error("[drill] start failed:", err);
  process.exit(1);
});
