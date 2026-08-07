#!/usr/bin/env node
import { startServer } from "./server.mjs";
startServer().catch((err) => {
  console.error("[whatsapp-web] start failed:", err);
  process.exit(1);
});
