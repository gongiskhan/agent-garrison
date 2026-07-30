#!/usr/bin/env node
// Omi channel own-port entrypoint — invoked by Garrison's runner during
// composition `up` (startOwnPortFitting spawns scripts/start.mjs) and by the
// per-fitting /api/fittings/omi-channel/start path. Hands off to server.mjs,
// which binds the port, writes the ~/.garrison/ui-fittings status file, and
// serves the webhook ingress + status surface.
import { startServer } from "./server.mjs";

startServer().catch((err) => {
  console.error("[omi-channel] start failed:", err);
  process.exit(1);
});
