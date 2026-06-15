#!/usr/bin/env node
// Model Router entrypoint — invoked by Garrison's runner during composition `up`.
import { startServer } from "./server.mjs";

startServer().catch((err) => {
  console.error("[model-router] start failed:", err);
  process.exit(1);
});
