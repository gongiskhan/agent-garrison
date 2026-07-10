#!/usr/bin/env node
// File Browser own-port entrypoint — spawned by Garrison's runner during `up`,
// by eager boot, and by /api/fittings/file-browser/start. Hands off to
// server.mjs, which binds the configured port (exits non-zero when taken),
// seeds the workspace namespaces, writes the ~/.garrison/ui-fittings status
// file, and serves the scoped File Browser surface.
import { startServer } from "./server.mjs";

startServer().catch((err) => {
  console.error("[file-browser] start failed:", err);
  process.exit(1);
});
