#!/usr/bin/env node
// Orchestrator entrypoint — invoked by Garrison's runner during composition `up`.
import { startServer } from "./server.mjs";

startServer().catch((err) => {
  console.error("[orchestrator] start failed:", err);
  process.exit(1);
});
