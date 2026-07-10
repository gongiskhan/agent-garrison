#!/usr/bin/env node
// Power Fitting entrypoint — invoked by Garrison's runner (detached lifecycle).
// Reads config/env/CLI and hands off to server.mjs.

import { startServer } from "./server.mjs";

startServer().catch((err) => {
  console.error("[power] start failed:", err);
  process.exit(1);
});
