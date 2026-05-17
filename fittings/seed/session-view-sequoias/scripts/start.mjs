#!/usr/bin/env node
// session-view-sequoias entrypoint. Invoked by Garrison's runner during composition `up`,
// or directly by users for standalone boot.
import { startServer } from "./server.mjs";

startServer().catch((err) => {
  console.error("[session-view] start failed:", err);
  process.exit(1);
});
