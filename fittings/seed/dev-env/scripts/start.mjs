#!/usr/bin/env node
// dev-env entrypoint. Invoked by Garrison's runner during composition `up`,
// or directly by users for standalone boot.
import { startServer } from "./server.mjs";

startServer().catch((err) => {
  console.error("[dev-env] start failed:", err);
  process.exit(1);
});
