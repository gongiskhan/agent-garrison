#!/usr/bin/env node
// Automations own-port entrypoint — spawned by Garrison's runner during
// composition `up` (startOwnPortFitting spawns scripts/start.mjs), by eager
// boot, and by /api/fittings/automations/start. Hands off to server.mjs, which
// binds a free port, writes the ~/.garrison/ui-fittings status file, and serves
// the automation CRUD/REST + run-viewer surface.
import { startServer } from "./server.mjs";

startServer().catch((err) => {
  console.error("[automations] start failed:", err);
  process.exit(1);
});
