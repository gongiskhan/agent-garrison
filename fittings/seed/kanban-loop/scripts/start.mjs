#!/usr/bin/env node
// Kanban Loop own-port entrypoint — invoked by Garrison's runner during
// composition `up` (startOwnPortFitting spawns scripts/start.mjs), by eager
// boot, and by the per-fitting /api/fittings/kanban-loop/start path. Hands off
// to server.mjs, which binds the board port, writes the ~/.garrison/ui-fittings
// status file Garrison surfaces at /embed/kanban-loop, and serves the REST/SSE
// surface + the responsive board UI.
import { startServer } from "./server.mjs";

startServer().catch((err) => {
  console.error("[kanban-loop] start failed:", err);
  process.exit(1);
});
