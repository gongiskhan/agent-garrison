#!/usr/bin/env node
// Ports Fitting entrypoint — invoked by Garrison's runner during composition `up`.
// Reads CLI args / env vars and hands off to server.mjs.

import { startServer } from "./server.mjs";

startServer().catch((err) => {
  console.error("[ports] start failed:", err);
  process.exit(1);
});
