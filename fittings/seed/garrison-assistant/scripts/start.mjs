#!/usr/bin/env node
// Garrison Assistant own-port entrypoint — spawned by Garrison's runner during
// `up`, by eager boot, and by /api/fittings/garrison-assistant/start. Hands off
// to server.mjs, which binds the configured port (exits non-zero when taken)
// and serves the Answer / Guide / Build surface + API.
import { startServer } from "./server.mjs";

startServer().catch((err) => {
  console.error("[garrison-assistant] start failed:", err);
  process.exit(1);
});
