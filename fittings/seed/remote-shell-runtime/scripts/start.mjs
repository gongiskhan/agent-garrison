#!/usr/bin/env node
// remote-shell entrypoint. Invoked by Garrison's runner during composition
// `up`, or directly for standalone boot.
import { startServer } from "./server.mjs";

startServer().catch((err) => {
  console.error("[remote-shell] start failed:", err);
  process.exit(1);
});
