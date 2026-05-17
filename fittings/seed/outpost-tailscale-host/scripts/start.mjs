#!/usr/bin/env node
import { startServer } from "./server.mjs";
startServer().catch((err) => {
  console.error("[outpost] start failed:", err);
  process.exit(1);
});
